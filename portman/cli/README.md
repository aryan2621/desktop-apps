# PortMan CLI

PortMan's command line tool: one self-contained Go binary per platform, no Python needed.

📖 Install and every command: **[PortMan user guide → The command line tool](../docs/user.md#the-command-line-tool)**
🛠 Building it: **[PortMan developer guide](../docs/dev.md#build-the-cli)**

```bash
portman list --state LISTEN      # what's listening
portman kill 3000                # stop what's on port 3000
portman info 3000                # details
portman watch                    # live view (k kill, f filter, q quit)
```

## Build

```bash
cd portman/cli
go build -o portman .

GOOS=darwin  GOARCH=arm64 go build -o portman-darwin-arm64 .
GOOS=darwin  GOARCH=amd64 go build -o portman-darwin-amd64 .
GOOS=linux   GOARCH=amd64 go build -o portman-linux-amd64 .
GOOS=linux   GOARCH=arm64 go build -o portman-linux-arm64 .
GOOS=windows GOARCH=amd64 go build -o portman-windows-amd64.exe .
```

Uses `gopsutil` to read ports, `cobra` for commands and Bubble Tea for `watch`. The desktop app
reads ports separately, through its Python core.
