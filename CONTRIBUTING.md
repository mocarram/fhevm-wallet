# Contributing

Thanks for your interest in contributing to fhEVM Wallet! This guide will help you get started.

## Getting Started

1. Fork the repository
2. Clone your fork:
   ```bash
   git clone https://github.com/YOUR_USERNAME/fhevm-wallet.git
   cd fhevm-wallet
   ```
3. Install dependencies:
   ```bash
   npm install
   ```
4. Create a branch for your changes:
   ```bash
   git checkout -b feature/your-feature-name
   ```

## Development

See [docs/development.md](docs/development.md) for detailed setup instructions.

```bash
# Run in development mode
npm run dev

# Build
npm run build

# Run linter
npm run lint

# Fix lint issues
npm run lint:fix

# Format code
npm run format
```

## Code Style

- We use ESLint and Prettier for code formatting
- Run `npm run lint` and `npm run format` before committing
- Follow existing patterns in the codebase
- Use TypeScript strict mode
- Write descriptive variable and function names

## Commit Messages

Use clear, descriptive commit messages:

```
feat: add token transfer confirmation prompt
fix: resolve balance cache invalidation issue
docs: update installation instructions
refactor: simplify wallet encryption logic
```

Prefixes:
- `feat:` - New feature
- `fix:` - Bug fix
- `docs:` - Documentation changes
- `refactor:` - Code refactoring
- `test:` - Adding or updating tests
- `chore:` - Maintenance tasks

## Pull Requests

1. Ensure your code passes linting and builds successfully:
   ```bash
   npm run lint
   npm run build
   ```

2. Update documentation if you've changed functionality

3. Keep PRs focused - one feature or fix per PR

4. Write a clear PR description explaining:
   - What changes you made
   - Why you made them
   - How to test them

## Reporting Issues

When reporting issues, please include:

- Node.js version (`node --version`)
- Operating system
- Steps to reproduce the issue
- Expected vs actual behavior
- Any error messages

## Project Structure

```
src/
├── cli/           # CLI commands and interactive mode
├── core/          # Business logic (wallet, token, FHE, network)
├── storage/       # Data persistence
└── utils/         # Utilities
```

## Questions?

Feel free to open an issue for questions or discussions.
