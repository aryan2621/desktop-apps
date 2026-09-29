# PortMan CLI (Go)

Pure Go implementation of the PortMan CLI. No Python required.

## Features

- **Cross-platform**: macOS, Linux, Windows
- **Fast startup**: Cold start is effectively instant for typical usage
- **Standalone**: Single binary per platform

## Build

```bash
cd cli

go mod download

# Build for current platform
go build -o portman .

# Build for all platforms
GOOS=darwin GOARCH=amd64 go build -o portman-darwin-amd64 .
GOOS=darwin GOARCH=arm64 go build -o portman-darwin-arm64 .
GOOS=linux GOARCH=amd64 go build -o portman-linux-amd64 .
GOOS=windows GOARCH=amd64 go build -o portman-windows-amd64.exe .
```

## Usage

```bash
# List ports
./portman list
./portman list --state LISTEN
./portman list --proc node
./portman list --json

# Kill by port
./portman kill 8080
./portman kill 8080 --force
./portman kill --state TIME_WAIT

# Live TUI
./portman watch

# Port info
./portman info 8080

# Version
./portman version
```

## Differences from Python core (GUI backend)

| Aspect | Python core | Go CLI |
|--------|-------------|--------|
| Install | Used by Tauri app | Download binary |
| Dependencies | psutil | Self-contained |
| Role | IPC server for GUI | Terminal tool |

## Why Go?

- Distribution: Users don't need Python installed for the CLI
- Speed: Fast startup and execution
- Portability: Single binary for each platform
- Reliability: Static typing catches errors early

## License

MIT
