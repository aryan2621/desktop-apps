package main

import (
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/charmbracelet/bubbles/table"
	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/spf13/cobra"
)

var watchCmd = &cobra.Command{
	Use:   "watch",
	Short: "Launch interactive TUI for live monitoring",
	Long:  "Start an interactive terminal UI that refreshes every 3 seconds with live port data.",
	RunE: func(cmd *cobra.Command, args []string) error {
		p := tea.NewProgram(initialModel(), tea.WithAltScreen())
		if _, err := p.Run(); err != nil {
			return fmt.Errorf("error running TUI: %w", err)
		}
		return nil
	},
}

// TUI Model
type model struct {
	ports       []PortInfo
	table       table.Model
	filterInput textinput.Model
	filtering   bool
	err         error
	lastRefresh time.Time
	width       int
	height      int
	sortColumn  string
	sortReverse bool
}

type refreshMsg struct {
	ports []PortInfo
	err   error
}

type tickMsg time.Time

func initialModel() model {
	// Setup table
	columns := []table.Column{
		{Title: "Port", Width: 8},
		{Title: "Protocol", Width: 8},
		{Title: "State", Width: 12},
		{Title: "PID", Width: 8},
		{Title: "Process", Width: 20},
		{Title: "Service", Width: 15},
		{Title: "Address", Width: 25},
	}

	t := table.New(
		table.WithColumns(columns),
		table.WithFocused(true),
		table.WithHeight(20),
	)

	s := table.DefaultStyles()
	s.Header = s.Header.
		BorderStyle(lipgloss.NormalBorder()).
		BorderForeground(lipgloss.Color("#6C63FF")).
		BorderBottom(true).
		Bold(false)
	s.Selected = s.Selected.
		Foreground(lipgloss.Color("#F0F0FF")).
		Background(lipgloss.Color("#6C63FF")).
		Bold(false)
	t.SetStyles(s)

	// Setup filter input
	ti := textinput.New()
	ti.Placeholder = "Filter by process name..."
	ti.CharLimit = 50
	ti.Width = 40

	return model{
		table:       t,
		filterInput: ti,
		sortColumn:  "port",
		sortReverse: false,
	}
}

func (m model) Init() tea.Cmd {
	return tea.Batch(
		refreshCmd(),
		tickCmd(),
	)
}

func (m model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.KeyMsg:
		if m.filtering {
			switch msg.String() {
			case "esc":
				m.filtering = false
				m.filterInput.SetValue("")
				m.updateTableRows()
				return m, nil
			case "enter":
				m.filtering = false
				m.updateTableRows()
				return m, nil
			}
			var cmd tea.Cmd
			m.filterInput, cmd = m.filterInput.Update(msg)
			return m, cmd
		}

		switch msg.String() {
		case "q", "ctrl+c":
			return m, tea.Quit
		case "r":
			return m, refreshCmd()
		case "k":
			return m, m.killSelected()
		case "f", "/":
			m.filtering = true
			return m, m.filterInput.Focus()
		case "1":
			m.sortColumn = "port"
			m.sortReverse = !m.sortReverse
			m.updateTableRows()
		case "2":
			m.sortColumn = "state"
			m.sortReverse = !m.sortReverse
			m.updateTableRows()
		case "3":
			m.sortColumn = "process"
			m.sortReverse = !m.sortReverse
			m.updateTableRows()
		}

	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		m.table.SetHeight(msg.Height - 8)

	case refreshMsg:
		if msg.err != nil {
			m.err = msg.err
		} else {
			m.ports = msg.ports
			m.lastRefresh = time.Now()
			m.err = nil
			m.updateTableRows()
		}
		return m, tickCmd()

	case tickMsg:
		return m, tea.Batch(refreshCmd(), tickCmd())
	}

	var cmd tea.Cmd
	m.table, cmd = m.table.Update(msg)
	return m, cmd
}

func (m model) View() string {
	if m.err != nil {
		return fmt.Sprintf("Error: %v\n\nPress q to quit.", m.err)
	}

	// Header
	violetStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#6C63FF")).Bold(true)
	dimStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#6B6B8A"))
	
	header := violetStyle.Render("  ◈ PortMan ") + dimStyle.Render("v1.0.0 - Live Port Monitor")

	// Status bar
	statusColor := "#6B6B8A"
	if time.Since(m.lastRefresh) < 5*time.Second {
		statusColor = "#00E5A0"
	}
	statusStyle := lipgloss.NewStyle().Foreground(lipgloss.Color(statusColor))
	
	refreshStr := "○"
	if time.Since(m.lastRefresh) < 3*time.Second {
		refreshStr = "●"
	}

	stats := m.getStats()
	status := fmt.Sprintf("  %s Refresh: 3s | Ports: %d | Listening: %d | Established: %d | Waiting: %d",
		statusStyle.Render(refreshStr),
		stats["total"],
		stats["listen"],
		stats["established"],
		stats["wait"],
	)

	// Help text
	help := dimStyle.Render("  [r]efresh [k]ill [f]ilter [1]sort-port [2]sort-state [3]sort-proc [q]uit")

	// Filter input
	filterView := ""
	if m.filtering {
		filterView = "\n  Filter: " + m.filterInput.View()
	}

	return fmt.Sprintf("%s\n\n%s\n%s\n\n%s%s", header, m.table.View(), status, help, filterView)
}

func (m *model) updateTableRows() {
	rows := m.getFilteredAndSortedRows()
	m.table.SetRows(rows)
}

func (m *model) getFilteredAndSortedRows() []table.Row {
	ports := m.ports

	// Apply filter
	if m.filterInput.Value() != "" {
		filter := strings.ToLower(m.filterInput.Value())
		var filtered []PortInfo
		for _, p := range ports {
			if strings.Contains(strings.ToLower(p.ProcessName), filter) ||
				strings.Contains(strings.ToLower(fmt.Sprintf("%d", p.Port)), filter) ||
				strings.Contains(strings.ToLower(p.State), filter) {
				filtered = append(filtered, p)
			}
		}
		ports = filtered
	}

	// Apply sort
	sort.Slice(ports, func(i, j int) bool {
		var result bool
		switch m.sortColumn {
		case "port":
			result = ports[i].Port < ports[j].Port
		case "state":
			result = ports[i].State < ports[j].State
		case "process":
			result = ports[i].ProcessName < ports[j].ProcessName
		default:
			result = ports[i].Port < ports[j].Port
		}
		if m.sortReverse {
			return !result
		}
		return result
	})

	// Convert to table rows
	var rows []table.Row
	for _, p := range ports {
		pidStr := "-"
		if p.PID > 0 {
			pidStr = fmt.Sprintf("%d", p.PID)
		}
		rows = append(rows, table.Row{
			fmt.Sprintf("%d", p.Port),
			p.Protocol,
			p.State,
			pidStr,
			p.ProcessName,
			p.ServiceTag,
			p.LocalAddress,
		})
	}

	return rows
}

func (m *model) getStats() map[string]int {
	stats := map[string]int{
		"total":       len(m.ports),
		"listen":      0,
		"established": 0,
		"wait":        0,
	}

	for _, p := range m.ports {
		switch strings.ToUpper(p.State) {
		case "LISTEN":
			stats["listen"]++
		case "ESTABLISHED":
			stats["established"]++
		case "TIME_WAIT", "CLOSE_WAIT":
			stats["wait"]++
		}
	}

	return stats
}

func (m *model) killSelected() tea.Cmd {
	if len(m.table.Rows()) == 0 {
		return nil
	}

	selected := m.table.SelectedRow()
	if selected == nil {
		return nil
	}

	portStr := selected[0]
	var port int
	fmt.Sscanf(portStr, "%d", &port)

	_, err := manager.KillPort(port, false)
	if err != nil {
		return func() tea.Msg {
			return refreshMsg{err: err}
		}
	}

	return refreshCmd()
}

func refreshCmd() tea.Cmd {
	return func() tea.Msg {
		ports, err := manager.GetAllPorts()
		return refreshMsg{ports: ports, err: err}
	}
}

func tickCmd() tea.Cmd {
	return tea.Tick(3*time.Second, func(t time.Time) tea.Msg {
		return tickMsg(t)
	})
}

func init() {
	// Initialize manager for watch command
	watchCmd.PreRunE = rootCmd.PersistentPreRunE
}
