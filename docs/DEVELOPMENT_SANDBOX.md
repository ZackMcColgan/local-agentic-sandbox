# Development in Docker Sandboxes

This guide documents how to develop and execute within isolated containerized sandboxes using Oleg Šelajev's sandbox kit.

---

## Running inside Docker Sandbox

To safely run development CLI tools inside a secure microVM environment with its own isolated Docker daemon:

```bash
# Launch inside a Docker Sandbox
sbx run --kit git+https://github.com/shelajev/agy-sbx-kit.git agy .
```

### Benefits
* **Workspace Isolation**: Keeps the developer workstation clean from generated artifacts and ephemeral packages.
* **Nested Daemon Support**: Enables Docker-in-Docker workflows without polluting the primary host daemon.
