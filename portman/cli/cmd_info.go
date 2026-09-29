package main

import (
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/fatih/color"
	"github.com/spf13/cobra"
)

var infoCmd = &cobra.Command{
	Use:   "info <port>",
	Short: "Show detailed port information",
	Long:  "Display detailed information about a specific port including process tree.",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		port, err := strconv.Atoi(args[0])
		if err != nil {
			return fmt.Errorf("invalid port number: %s", args[0])
		}

		ports, err := manager.GetAllPorts()
		if err != nil {
			return err
		}

		var target *PortInfo
		for i := range ports {
			if ports[i].Port == port {
				target = &ports[i]
				break
			}
		}

		if target == nil {
			return fmt.Errorf("port %d not found or not in use", port)
		}

		// Print info panel
		violet := color.New(color.FgHiMagenta).SprintFunc()
		cyan := color.New(color.FgCyan).SprintFunc()
		green := color.New(color.FgGreen).SprintFunc()
		blue := color.New(color.FgBlue).SprintFunc()
		yellow := color.New(color.FgYellow).SprintFunc()
		red := color.New(color.FgRed).SprintFunc()
		dim := color.New(color.FgHiBlack).SprintFunc()

		fmt.Println(violet("┌─────────────────────────────────────────┐"))
		fmt.Printf(violet("│  Port %d Info\n"), port)
		fmt.Println(violet("├─────────────────────────────────────────┤"))

		if target.ServiceTag != "" {
			fmt.Printf("│  Service:   %s\n", cyan(target.ServiceTag))
		}
		fmt.Printf("│  Port:      %s\n", violet(target.Port))
		fmt.Printf("│  Protocol:  %s\n", target.Protocol)

		stateStr := target.State
		switch strings.ToUpper(target.State) {
		case "LISTEN":
			stateStr = green(target.State)
		case "ESTABLISHED":
			stateStr = blue(target.State)
		case "TIME_WAIT":
			stateStr = yellow(target.State)
		case "CLOSE_WAIT":
			stateStr = red(target.State)
		}
		fmt.Printf("│  State:     %s\n", stateStr)
		fmt.Printf("│  Local:     %s\n", target.LocalAddress)
		if target.ForeignAddress != "" {
			fmt.Printf("│  Foreign:   %s\n", target.ForeignAddress)
		}

		fmt.Println(violet("├─────────────────────────────────────────┤"))
		fmt.Printf("│  Process:   %s\n", cyan(target.ProcessName))
		if target.PID > 0 {
			fmt.Printf("│  PID:       %d\n", target.PID)
		}
		if target.ParentProcess != "" {
			fmt.Printf("│  Parent:    %s\n", dim(target.ParentProcess))
		}
		if target.StartedAt != nil {
			fmt.Printf("│  Started:   %s\n", target.StartedAt.Format("2006-01-02 15:04:05"))
			fmt.Printf("│  Uptime:    %s\n", formatDuration(time.Since(*target.StartedAt)))
		}
		fmt.Println(violet("└─────────────────────────────────────────┘"))

		// Process tree
		if target.PID > 0 {
			tree, err := manager.GetProcessTree(target.PID)
			if err == nil && tree != nil {
				fmt.Println()
				fmt.Println(dim("Process Tree:"))
				fmt.Printf("  %s\n", cyan(tree.Name))
				if tree.Parent != nil {
					fmt.Printf("  └─ Parent: %s (PID %d)\n", dim(tree.Parent.Name), tree.Parent.PID)
				}
				for _, child := range tree.Children {
					fmt.Printf("  └─ Child:  %s (PID %d)\n", dim(child.Name), child.PID)
				}
			}
		}

		return nil
	},
}
