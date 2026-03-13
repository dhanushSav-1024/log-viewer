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

Open **http://0.0.0.0:8080** in your browser — that's it.

## Options

| Flag | Default   | Description                                                                                                 |
| ---- | --------- | ----------------------------------------------------------------------------------------------------------- |
| `-i` | `0.0.0.0` | Bind address. It is recommended to use `127.0.0.1` if the server should only be accessible locally.         |
| `-p` | `8080`    | HTTP server port.                                                                                           |
| `-m` | `1000`    | Maximum number of logs stored in the in-memory backend. Older logs are discarded when the limit is reached. |
| `-u` | `None`    | UDP port for receiving logs. If not set, UDP logging is disabled.                                           |
| `-l` | `off`     | Enable file logging. Logs are saved to `/home/user/app-name/logs-<timestamp>.log`.                          |


## Features

- Live log stream with auto-reconnect
- Filter by level · fuzzy search · JSON inspector
- Single binary, no dependencies
