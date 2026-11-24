# Host-dependent acceptance criteria: dry run on macOS and Docker

Date: 2026-11-24. Docker is OrbStack (server 29.8.2, linux/aarch64). Image `rust:1` (rustc 1.100.0; the Mac has 1.95.0). Not a numbered PRD task; run early so that no criterion is found unsatisfiable at T-5.3.

| Item | macOS | Linux (Docker `rust:1`) | Consequence |
|---|---|---|---|
| AC-69 unprivileged bind to port 80 on `127.0.0.1` | `Permission denied` (uid 501) | **Succeeds** as root and as uid 1000 (default `net.ipv4.ip_unprivileged_port_start=0`) | Linux variant needs `--user 1000 --sysctl net.ipv4.ip_unprivileged_port_start=1024`, which makes the bind fail with `Permission denied` (measured) |
| Non-local address bind (`192.0.2.1:4100`) | `Can't assign requested address` (errno 49) | `Cannot assign requested address` (errno 99) | Works on both; usable as an extra bind-error check |
| `0.0.0.0:80` unprivileged bind | succeeds on macOS | not tested | not used for AC-69 |
| `lsof`, `ss`, `netstat` | `lsof` present | **none present** in the image | AC-28 needs a helper that falls back to `/proc/net/tcp` |
| `--open` (AC-63, AC-68) | opens the default browser | no desktop | Manual on macOS; on Linux assert the warning-and-continue path only |
| Reaching a container server from the Mac's Chrome | n/a | `docker run --network host` with the server bound to `127.0.0.1` is reachable from the Mac at `127.0.0.1:<port>` (HTTP 200, measured). `-p 127.0.0.1:P:P` does NOT work when the server binds loopback inside the container (connection fails, measured) | Linux browser checks use `--network host`; the server stays on `127.0.0.1`, so the Host check stays under test |

Other Docker containers belong to the user (`onelegion-dev-*`, `verdikra_*`). Probe containers use unique names and are removed after use. Test ports are in the 4100 to 4199 range.
