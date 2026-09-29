package main

import (
	"fmt"
	"os"

	"github.com/spf13/cobra"
)

var (
	version = "1.0.0"
	manager *PortManager
)

var rootCmd = &cobra.Command{
	Use:   "portman",
	Short: "PortMan - Own your ports",
	Long:  `Cross-platform CLI: list ports, kill processes, watch live.`,
	PersistentPreRunE: func(cmd *cobra.Command, args []string) error {
		manager = NewPortManager()
		return nil
	},
}

func init() {
	rootCmd.AddCommand(listCmd)
	rootCmd.AddCommand(killCmd)
	rootCmd.AddCommand(watchCmd)
	rootCmd.AddCommand(infoCmd)
	rootCmd.AddCommand(versionCmd)
}

func main() {
	if err := rootCmd.Execute(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

var versionCmd = &cobra.Command{
	Use:   "version",
	Short: "Show version information",
	Run: func(cmd *cobra.Command, args []string) {
		fmt.Printf("PortMan %s\n", version)
	},
}
