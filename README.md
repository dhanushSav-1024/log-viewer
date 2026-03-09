# log-view

Real-time log viewer for your apps. Send logs to http://ip:port/api/logs, view them in the browser.

![status](https://img.shields.io/badge/status-stable-green)

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/dhanushSav-1024/log-viewer/main/install.sh | bash
```

## Usage

**Start the server**
```bash
log-view
```

**Send logs via udp**
```bash
echo '{"level":"critical","time":"33", "message":"{\"sensor\":\"GLL\",\"status\":\"FAIL\"}"}' | socat - UDP-DATAGRAM:127.0.0.1:9000
```

**Send logs via tcp**
```bash
curl -X POST http://127.0.0.1:8080/api/log \
  -H "Content-Type: application/json" \
  -d '{"message":"test log entry"}
```

Open **http://localhost:8080** in your browser — that's it.

## Options

| Flag | Default | Description |
|------|---------|-------------|
| `-i` | `0.0.0.0` | Bind address |
| `-p` | `8080` | Port |
| `-m` | `1000` | Max logs in buffer |
| `-u` | `9000` | udp log listener port |
| `-l` | off | Save logs to file |

## Features

- Live log stream with auto-reconnect
- Filter by level · fuzzy search · JSON inspector
- Single binary, no dependencies
