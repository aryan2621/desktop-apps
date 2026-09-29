package main

import (
	"fmt"
	"os"
	"runtime"
	"sort"
	"strings"
	"syscall"
	"time"

	"github.com/shirou/gopsutil/v3/net"
	"github.com/shirou/gopsutil/v3/process"
)

const accessDeniedKill = "Permission denied: cannot terminate this process. " +
	"On macOS/Linux, run PortMan with sudo; on Windows, run the terminal as Administrator. " +
	"Some processes are protected by the OS."

func truncateJoinedCmdline(parts []string, max int) string {
	s := strings.Join(parts, " ")
	if len(s) <= max {
		return s
	}
	if max <= 1 {
		return "…"
	}
	runes := []rune(s)
	if len(runes) <= max {
		return s
	}
	return string(runes[:max-1]) + "…"
}

func cgroupContainerHint(pid int32) string {
	if runtime.GOOS != "linux" {
		return ""
	}
	data, err := os.ReadFile(fmt.Sprintf("/proc/%d/cgroup", pid))
	if err != nil {
		return ""
	}
	s := string(data)
	switch {
	case strings.Contains(s, "kubepods"):
		return "Kubernetes pod (cgroup)"
	case strings.Contains(s, "docker"), strings.Contains(s, "containerd"):
		return "Container (cgroup)"
	default:
		return ""
	}
}

// PortInfo represents a single port connection
type PortInfo struct {
	Port            int
	Protocol        string
	State           string
	PID             int32
	ProcessName     string
	ParentProcess   string
	LocalAddress    string
	ForeignAddress  string
	StartedAt       *time.Time
	ServiceTag      string
	Username        string
	Cwd             string
	CmdlinePreview  string
	ContainerHint   string
}

// PortManager handles port operations
type PortManager struct{}

// NewPortManager creates a new port manager
func NewPortManager() *PortManager {
	return &PortManager{}
}

// GetAllPorts retrieves all active ports with process information
func (pm *PortManager) GetAllPorts() ([]PortInfo, error) {
	connections, err := net.Connections("all")
	if err != nil {
		return nil, fmt.Errorf("failed to get connections: %w", err)
	}

	var ports []PortInfo
	seen := make(map[string]bool)

	for _, conn := range connections {
		// Skip duplicates
		key := fmt.Sprintf("%s:%d-%s-%d", conn.Laddr.IP, conn.Laddr.Port, conn.Type, conn.Pid)
		if seen[key] {
			continue
		}
		seen[key] = true

		port := PortInfo{
			Port:         int(conn.Laddr.Port),
			Protocol:     protocolFromType(conn.Type),
			State:        conn.Status,
			PID:          conn.Pid,
			LocalAddress: fmt.Sprintf("%s:%d", conn.Laddr.IP, conn.Laddr.Port),
			ServiceTag:   getServiceTag(int(conn.Laddr.Port)),
		}

		if conn.Raddr.Port > 0 {
			port.ForeignAddress = fmt.Sprintf("%s:%d", conn.Raddr.IP, conn.Raddr.Port)
		}

		// Get process info if PID available
		if conn.Pid > 0 {
			if proc, err := process.NewProcess(conn.Pid); err == nil {
				if name, err := proc.Name(); err == nil {
					port.ProcessName = name
				}
				if parent, err := proc.Parent(); err == nil {
					if name, err := parent.Name(); err == nil {
						port.ParentProcess = name
					}
				}
				if createTime, err := proc.CreateTime(); err == nil {
					t := time.UnixMilli(createTime)
					port.StartedAt = &t
				}
				if cwd, err := proc.Cwd(); err == nil {
					port.Cwd = cwd
				}
				if u, err := proc.Username(); err == nil {
					port.Username = u
				}
				if cmd, err := proc.CmdlineSlice(); err == nil && len(cmd) > 0 {
					port.CmdlinePreview = truncateJoinedCmdline(cmd, 120)
				}
				port.ContainerHint = cgroupContainerHint(conn.Pid)
			}
		}

		ports = append(ports, port)
	}

	// Sort by port number
	sort.Slice(ports, func(i, j int) bool {
		return ports[i].Port < ports[j].Port
	})

	return ports, nil
}

// FilterPorts filters ports by criteria
func (pm *PortManager) FilterPorts(ports []PortInfo, state, procName string) []PortInfo {
	var filtered []PortInfo

	for _, p := range ports {
		if state != "" && !strings.EqualFold(p.State, state) {
			continue
		}
		if procName != "" && !strings.Contains(strings.ToLower(p.ProcessName), strings.ToLower(procName)) {
			continue
		}
		filtered = append(filtered, p)
	}

	return filtered
}

// KillPort kills a process by port number (dryRun previews without terminating).
func (pm *PortManager) KillPort(port int, dryRun bool) (*KillResult, error) {
	ports, err := pm.GetAllPorts()
	if err != nil {
		return nil, err
	}

	var target *PortInfo
	for i := range ports {
		if ports[i].Port == port && ports[i].PID > 0 {
			target = &ports[i]
			break
		}
	}

	if target == nil {
		return nil, fmt.Errorf("no process found using port %d", port)
	}

	return pm.KillPID(target.PID, port, dryRun)
}

// KillPID kills a process by PID (or previews kill when dryRun).
func (pm *PortManager) KillPID(pid int32, port int, dryRun bool) (*KillResult, error) {
	proc, err := process.NewProcess(pid)
	if err != nil {
		return nil, fmt.Errorf("process %d not found", pid)
	}

	name, _ := proc.Name()

	if dryRun {
		return &KillResult{
			Success:     true,
			DryRun:      true,
			PID:         pid,
			ProcessName: name,
			Port:        port,
		}, nil
	}

	// Try graceful termination first, then force it. gopsutil's Kill sends SIGKILL on Unix and
	// calls TerminateProcess on Windows, so this also builds on Windows (syscall.Kill doesn't exist there).
	if err := proc.Terminate(); err != nil {
		if err := proc.Kill(); err != nil {
			return nil, fmt.Errorf("%s", accessDeniedKill)
		}
	}

	time.Sleep(100 * time.Millisecond)

	return &KillResult{
		Success:     true,
		PID:         pid,
		ProcessName: name,
		Port:        port,
	}, nil
}

// KillByState kills all processes in a specific state (dryRun previews).
func (pm *PortManager) KillByState(state string, dryRun bool) (*BulkKillResult, error) {
	ports, err := pm.GetAllPorts()
	if err != nil {
		return nil, err
	}

	result := &BulkKillResult{DryRun: dryRun}

	for _, p := range ports {
		if !strings.EqualFold(p.State, state) || p.PID == 0 {
			continue
		}

		killResult, err := pm.KillPID(p.PID, p.Port, dryRun)
		if err != nil {
			result.Errors = append(result.Errors, PortError{Port: p.Port, Error: err.Error()})
		} else {
			result.Killed = append(result.Killed, *killResult)
		}
	}

	result.Success = len(result.Errors) == 0
	result.KilledCount = len(result.Killed)

	return result, nil
}

// GetProcessTree returns process tree info
func (pm *PortManager) GetProcessTree(pid int32) (*ProcessTree, error) {
	proc, err := process.NewProcess(pid)
	if err != nil {
		return nil, fmt.Errorf("process %d not found", pid)
	}

	tree := &ProcessTree{
		PID:  pid,
		Name: "Unknown",
	}

	if name, err := proc.Name(); err == nil {
		tree.Name = name
	}

	if parent, err := proc.Parent(); err == nil {
		tree.Parent = &ProcessInfo{
			PID:  parent.Pid,
			Name: "Unknown",
		}
		if name, err := parent.Name(); err == nil {
			tree.Parent.Name = name
		}
	}

	if children, err := proc.Children(); err == nil {
		for _, child := range children {
			info := ProcessInfo{
				PID:  child.Pid,
				Name: "Unknown",
			}
			if name, err := child.Name(); err == nil {
				info.Name = name
			}
			tree.Children = append(tree.Children, info)
		}
	}

	if createTime, err := proc.CreateTime(); err == nil {
		t := time.UnixMilli(createTime)
		tree.Created = &t
	}

	if cmdline, err := proc.CmdlineSlice(); err == nil {
		tree.Cmdline = cmdline
	}

	return tree, nil
}

// Helper functions

func protocolFromType(sockType uint32) string {
	switch sockType {
	case syscall.SOCK_STREAM:
		return "TCP"
	case syscall.SOCK_DGRAM:
		return "UDP"
	default:
		return fmt.Sprintf("TYPE-%d", sockType)
	}
}

// KnownPorts maps well-known ports to service names
var knownPorts = map[int]string{
	20:    "FTP Data",
	21:    "FTP",
	22:    "SSH",
	23:    "Telnet",
	25:    "SMTP",
	53:    "DNS",
	80:    "HTTP",
	110:   "POP3",
	143:   "IMAP",
	443:   "HTTPS",
	465:   "SMTPS",
	587:   "SMTP Submission",
	993:   "IMAPS",
	995:   "POP3S",
	1433:  "MS SQL Server",
	1521:  "Oracle",
	1723:  "PPTP",
	2181:  "ZooKeeper",
	2375:  "Docker",
	2376:  "Docker TLS",
	3000:  "Dev Server",
	3306:  "MySQL",
	3360:  "MariaDB",
	3389:  "RDP",
	4200:  "Angular Dev",
	4369:  "Erlang EPMD",
	5000:  "Flask/Dev",
	5432:  "PostgreSQL",
	5500:  "VNC",
	5601:  "Kibana",
	5672:  "RabbitMQ",
	5900:  "VNC Server",
	5984:  "CouchDB",
	6379:  "Redis",
	6443:  "Kubernetes API",
	8000:  "Django/Dev",
	8080:  "HTTP Alt",
	8081:  "HTTP Alt 2",
	8443:  "HTTPS Alt",
	9200:  "Elasticsearch",
	9092:  "Kafka",
	27017: "MongoDB",
	27018: "MongoDB Shard",
	27019: "MongoDB Config",
}

func getServiceTag(port int) string {
	if tag, ok := knownPorts[port]; ok {
		return tag
	}
	return ""
}

// Result types

type KillResult struct {
	Success     bool
	PID         int32
	ProcessName string
	Port        int
	Error       string
	DryRun      bool
}

type BulkKillResult struct {
	Success     bool
	KilledCount int
	Killed      []KillResult
	Errors      []PortError
	DryRun      bool
}

type PortError struct {
	Port  int
	Error string
}

type ProcessTree struct {
	PID      int32
	Name     string
	Parent   *ProcessInfo
	Children []ProcessInfo
	Created  *time.Time
	Cmdline  []string
}

type ProcessInfo struct {
	PID  int32
	Name string
}

// Export helpers for JSON output
func (p PortInfo) ToMap() map[string]interface{} {
	m := map[string]interface{}{
		"port":          p.Port,
		"protocol":      p.Protocol,
		"state":         p.State,
		"pid":           p.PID,
		"process_name":  p.ProcessName,
		"local_address": p.LocalAddress,
		"service_tag":   p.ServiceTag,
	}
	if p.ParentProcess != "" {
		m["parent_process"] = p.ParentProcess
	}
	if p.ForeignAddress != "" {
		m["foreign_address"] = p.ForeignAddress
	}
	if p.StartedAt != nil {
		m["started_at"] = p.StartedAt.Format(time.RFC3339)
	}
	if p.Username != "" {
		m["username"] = p.Username
	}
	if p.Cwd != "" {
		m["cwd"] = p.Cwd
	}
	if p.CmdlinePreview != "" {
		m["cmdline_preview"] = p.CmdlinePreview
	}
	if p.ContainerHint != "" {
		m["container_hint"] = p.ContainerHint
	}
	return m
}
