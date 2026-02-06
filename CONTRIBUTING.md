# Contributing to SelfClaw

Thanks for your interest in contributing to SelfClaw! This project builds privacy-first agent verification on the Celo blockchain using Self.xyz passport proofs.

## Getting Started

1. **Fork and clone the repository**

   ```bash
   git clone https://github.com/your-username/selfclaw.git
   cd selfclaw
   ```

2. **Install dependencies**

   ```bash
   npm install
   ```

3. **Set up environment variables**

   ```bash
   cp .env.example .env
   ```

   Fill in your values — at minimum you need `DATABASE_URL` and `SESSION_SECRET`.

4. **Set up PostgreSQL**

   Create a PostgreSQL database and update `DATABASE_URL` in your `.env` file.

5. **Push the database schema**

   ```bash
   npm run db:push
   ```

6. **Start the development server**

   ```bash
   npm run dev
   ```

   The app will be available at `http://localhost:5000`.

## Code Style

- **TypeScript** — all source files use TypeScript
- Follow existing patterns and conventions in the codebase
- Semicolons are optional (match the style of the file you're editing)
- Use meaningful variable and function names

## Submitting a Pull Request

1. Create a feature branch from `main` (`git checkout -b feature/your-feature`)
2. Make your changes and test them locally
3. Commit with a clear, descriptive message
4. Push your branch and open a pull request
5. Describe what your PR does and why

Please keep PRs focused — one feature or fix per pull request.

## Reporting Issues

Open an issue on GitHub with:

- A clear title and description
- Steps to reproduce (if applicable)
- Expected vs. actual behavior
- Your environment details (Node.js version, OS)

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
