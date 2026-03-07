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

**Send logs from Python**
```python
import logging
from log-view import HttpLogHandler

logging.getLogger().addHandler(HttpLogHandler("http://localhost:8080/api/log"))
logging.info("hello from my app")
```

Open **http://localhost:8080** in your browser — that's it.

## Options

| Flag | Default | Description |
|------|---------|-------------|
| `-i` | `0.0.0.0` | Bind address |
| `-p` | `8080` | Port |
| `-m` | `1000` | Max logs in buffer |
| `-l` | off | Save logs to file |

## Features

- Live log stream with auto-reconnect
- Filter by level · fuzzy search · JSON inspector
- Single binary, no dependencies