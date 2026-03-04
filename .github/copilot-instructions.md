# Copilot Instructions for Agora Relay

## Project Summary
Agora Relay is a minimal WebSocket relay for Agora peer-to-peer messaging.

## Architecture & Testability Requirements
1. Keep process shells thin: CLI handlers, HTTP servers, workers, and subprocess launchers should only parse input, call services, and map output/errors.
2. Put business logic in services behind interfaces, not in process entrypoints.
3. Abstract environment dependencies (file system, process execution, time, env, network transport) behind injectible interfaces.
4. Ensure services are unit-testable without opening ports or spawning processes.
5. Prefer service-level unit tests by default; reserve real process/port tests for minimal, explicitly labeled integration coverage.

## Working Style
- Start coding tasks with `git pull`.
- Keep increments small and legible.
- Prefer simple designs; refactor first when needed.
- Use TDD (red/green/refactor) where practical.
- End completed tasks with pull, build, lint, test, commit, and push.
