# Development in Docker Sandboxes (Google Antigravity & agy-sbx-kit)

This guide documents how to develop and execute within isolated containerized sandboxes using Google Antigravity (`agy`) and Oleg Šelajev's sandbox kit.

---

## Running Antigravity inside Docker Sandbox

To safely run the Google Antigravity CLI (`agy`) inside a secure microVM environment with its own isolated Docker daemon:

```bash
# Launch Antigravity inside a Docker Sandbox
sbx run --kit git+https://github.com/shelajev/agy-sbx-kit.git agy .
```

### Benefits
* **Workspace Isolation**: Keeps the developer workstation clean from generated artifacts and ephemeral packages.
* **Nested Daemon Support**: Enables Docker-in-Docker workflows without polluting the primary host daemon.
