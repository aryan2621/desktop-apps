package main

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"github.com/fatih/color"
	"github.com/olekukonko/tablewriter"
	"github.com/spf13/cobra"
)

var (
	listState string
	listProc  string
	listJSON  bool
)

var listCmd = &cobra.Command{
	Use:   "list",
	Short: "List all active ports",
	Long:  "Display a table of all active network ports with process information.",
	RunE: func(cmd *cobra.Command, args []string) error {
		ports, err := manager.GetAllPorts()
		if err != nil {
			return fmt.Errorf("failed to get ports: %w", err)
		}

		filtered := manager.FilterPorts(ports, listState, listProc)

		if listJSON {
			var output []map[string]interface{}
			for _, p := range filtered {
				output = append(output, p.ToMap())
			}
			encoder := json.NewEncoder(os.Stdout)
			encoder.SetIndent("", "  ")
			return encoder.Encode(output)
		}

		// Table output
		if len(filtered) == 0 {
			fmt.Println(color.YellowString("No ports found"))
			return nil
		}

		table := tablewriter.NewWriter(os.Stdout)
		table.SetHeader([]string{"Port", "Protocol", "State", "PID", "Process", "Service", "Address"})
		table.SetAutoWrapText(false)
		table.SetAutoFormatHeaders(true)
		table.SetHeaderAlignment(tablewriter.ALIGN_LEFT)
		table.SetAlignment(tablewriter.ALIGN_LEFT)
		table.SetCenterSeparator("")
		table.SetColumnSeparator("")
		table.SetRowSeparator("")
		table.SetHeaderLine(false)
		table.SetBorder(false)
		table.SetTablePadding("\t")
		table.SetNoWhiteSpace(true)

		// Color setup
		violet := color.New(color.FgHiMagenta).SprintFunc()
		green := color.New(color.FgGreen).SprintFunc()
		blue := color.New(color.FgBlue).SprintFunc()
		yellow := color.New(color.FgYellow).SprintFunc()
		red := color.New(color.FgRed).SprintFunc()
		dim := color.New(color.FgHiBlack).SprintFunc()

		for _, p := range filtered {
			stateStr := p.State
			switch strings.ToUpper(p.State) {
			case "LISTEN":
				stateStr = green(p.State)
			case "ESTABLISHED":
				stateStr = blue(p.State)
			case "TIME_WAIT":
				stateStr = yellow(p.State)
			case "CLOSE_WAIT":
				stateStr = red(p.State)
			}

			pidStr := "-"
			if p.PID > 0 {
				pidStr = fmt.Sprintf("%d", p.PID)
			}

			serviceStr := p.ServiceTag
			if serviceStr == "" {
				serviceStr = ""
			}

			table.Append([]string{
				violet(fmt.Sprintf("%d", p.Port)),
				p.Protocol,
				stateStr,
				pidStr,
				p.ProcessName,
				dim(serviceStr),
				p.LocalAddress,
			})
		}

		table.Render()

		// Summary
		listening := 0
		established := 0
		timeWait := 0
		for _, p := range filtered {
			switch strings.ToUpper(p.State) {
			case "LISTEN":
				listening++
			case "ESTABLISHED":
				established++
			case "TIME_WAIT":
				timeWait++
			}
		}

		violetBullet := color.New(color.FgHiMagenta).Sprint("◈")
		fmt.Printf("\n%s %s ports active  ·  %s listening  ·  %s established  ·  %s waiting\n",
			violetBullet,
			color.WhiteString(fmt.Sprintf("%d", len(filtered))),
			green(fmt.Sprintf("%d", listening)),
			blue(fmt.Sprintf("%d", established)),
			yellow(fmt.Sprintf("%d", timeWait)),
		)

		return nil
	},
}

func init() {
	listCmd.Flags().StringVarP(&listState, "state", "s", "", "Filter by state (LISTEN, ESTABLISHED, TIME_WAIT, CLOSE_WAIT)")
	listCmd.Flags().StringVarP(&listProc, "proc", "p", "", "Filter by process name")
	listCmd.Flags().BoolVarP(&listJSON, "json", "j", false, "Output as JSON")
}
