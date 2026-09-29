package main

import (
	"bufio"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/fatih/color"
	"github.com/spf13/cobra"
)

var (
	killForce  bool
	killState  string
	killDryRun bool
)

var killCmd = &cobra.Command{
	Use:   "kill <port>",
	Short: "Kill a process by port",
	Long:  "Terminate the process using the specified port number.",
	Args: func(cmd *cobra.Command, args []string) error {
		if killState != "" {
			return nil
		}
		if len(args) < 1 {
			return fmt.Errorf("requires a port number or --state flag")
		}
		return nil
	},
	RunE: func(cmd *cobra.Command, args []string) error {
		if killState != "" {
			result, err := manager.KillByState(killState, killDryRun)
			if err != nil {
				return err
			}

			if killDryRun && result.KilledCount > 0 {
				color.Yellow("Dry run — would terminate %d processes in %s state:\n", result.KilledCount, killState)
				for _, k := range result.Killed {
					fmt.Printf("  PID %d  %s  port %d\n", k.PID, k.ProcessName, k.Port)
				}
				return nil
			}

			if result.KilledCount > 0 {
				color.Green("✓ Killed %d processes in %s state\n", result.KilledCount, killState)
			}
			if len(result.Errors) > 0 {
				color.Red("✗ Failed to kill %d processes:\n", len(result.Errors))
				for _, e := range result.Errors {
					fmt.Printf("  Port %d: %s\n", e.Port, e.Error)
				}
			}
			return nil
		}

		// Single port kill
		port, err := parsePort(args[0])
		if err != nil {
			return err
		}

		// Find the process
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
			return fmt.Errorf("no process found using port %d", port)
		}

		if target.PID == 0 {
			return fmt.Errorf("port %d has no associated process", port)
		}

		// Show process info
		uptime := "Unknown"
		if target.StartedAt != nil {
			uptime = formatDuration(time.Since(*target.StartedAt))
		}

		cyan := color.New(color.FgCyan).SprintFunc()
		violet := color.New(color.FgHiMagenta).SprintFunc()
		yellow := color.New(color.FgYellow).SprintFunc()

		fmt.Println(yellow("┌─────────────────────────────────────────┐"))
		fmt.Println(yellow("│") + "  Process to Kill                        " + yellow("│"))
		fmt.Println(yellow("├─────────────────────────────────────────┤"))
		fmt.Printf(yellow("│")+"  Process: %s\n", cyan(target.ProcessName))
		fmt.Printf(yellow("│")+"  PID:      %d\n", target.PID)
		fmt.Printf(yellow("│")+"  Port:     %s\n", violet(port))
		fmt.Printf(yellow("│")+"  Uptime:   %s\n", uptime)
		fmt.Println(yellow("└─────────────────────────────────────────┘"))
		fmt.Println()

		// Confirmation
		if killDryRun {
			result, err := manager.KillPID(target.PID, port, true)
			if err != nil {
				return err
			}
			color.Yellow("Dry run — %s (PID %d) on port %d would be terminated.\n", result.ProcessName, result.PID, port)
			return nil
		}

		if !killForce {
			fmt.Print(color.RedString("Kill this process? [y/N]: "))
			reader := bufio.NewReader(os.Stdin)
			response, _ := reader.ReadString('\n')
			response = strings.TrimSpace(strings.ToLower(response))
			if response != "y" && response != "yes" {
				fmt.Println(color.HiBlackString("Aborted."))
				return nil
			}
		}

		// Kill
		result, err := manager.KillPID(target.PID, port, false)
		if err != nil {
			return fmt.Errorf(color.RedString("✗ %s", err.Error()))
		}

		color.Green("✓ Killed %s (PID %d) using port %d\n", result.ProcessName, result.PID, port)
		return nil
	},
}

func init() {
	killCmd.Flags().BoolVarP(&killForce, "force", "f", false, "Skip confirmation")
	killCmd.Flags().BoolVar(&killDryRun, "dry-run", false, "Show what would be killed without terminating")
	killCmd.Flags().StringVar(&killState, "state", "", "Kill all ports in state (TIME_WAIT, CLOSE_WAIT, etc.)")
}

func parsePort(s string) (int, error) {
	port, err := fmt.Sscanf(s, "%d", new(int))
	if err != nil || port != 1 {
		return 0, fmt.Errorf("invalid port number: %s", s)
	}
	var p int
	fmt.Sscanf(s, "%d", &p)
	return p, nil
}

func formatDuration(d time.Duration) string {
	if d.Hours() >= 24 {
		return fmt.Sprintf("%dd", int(d.Hours()/24))
	}
	if d.Hours() >= 1 {
		return fmt.Sprintf("%dh", int(d.Hours()))
	}
	if d.Minutes() >= 1 {
		return fmt.Sprintf("%dm", int(d.Minutes()))
	}
	return fmt.Sprintf("%ds", int(d.Seconds()))
}
