# CI/CD Pipeline with GitHub Actions

A production-style CI/CD pipeline built around a Node.js Express application.
Every time code is pushed to main, GitHub automatically runs tests, builds a
Docker image, and pushes it to Docker Hub — without any manual intervention.

This project is not about the Node.js app itself. The app is intentionally tiny
and simple. The focus is entirely on the pipeline around it — automated testing,
containerisation, and image delivery. That is what DevOps engineers own.

---

## What This Project Does

When you push code to the main branch, the following happens automatically:

1. GitHub spins up a fresh Ubuntu machine (not your laptop, their server)
2. Your repo is cloned onto that machine
3. Node.js 18 is installed
4. All dependencies are installed via `npm install`
5. Both API tests are run via Jest — if either fails, everything stops here
6. A second Ubuntu machine is spun up for the build job
7. It logs into Docker Hub using credentials stored as GitHub Secrets
8. A Docker image is built from the Dockerfile
9. The image is pushed to Docker Hub with two tags — `:latest` and `:git-commit-hash`
10. Both machines are destroyed by GitHub
11. Pipeline shows green

Pull requests only trigger the test job. They do not build or push images.
Only code that is actually merged into main gets built and shipped.

---

## Project Structure

```
cicd-pipeline/
├── src/
│   ├── app.js          # Express app — defines routes and logic
│   └── server.js       # Starts the app on a port
├── tests/
│   └── app.test.js     # Jest tests for both API endpoints
├── .github/
│   └── workflows/
│       └── ci.yml      # The full CI/CD pipeline definition
├── Dockerfile          # Instructions to containerise the app
├── package.json        # Project manifest — dependencies and scripts
├── .gitignore          # Tells Git what not to commit
└── README.md
```

---

## Application Endpoints

| Endpoint  | Method | Response                                          |
|-----------|--------|---------------------------------------------------|
| `/`       | GET    | `{"status": "ok", "message": "Hello from cicd-pipeline"}` |
| `/health` | GET    | `{"status": "healthy"}`                           |

The `/health` endpoint follows a pattern used universally in production systems.
Kubernetes liveness probes, AWS load balancers, and monitoring tools all hit a
health endpoint to check if the application is alive. If it returns 200, the app
is healthy. If it does not respond, the container gets restarted automatically.

---

## How to Run Locally

**Prerequisites:** Docker Desktop installed and running.

Clone the repo:
```bash
git clone git@github.com:yourusername/cicd-pipeline.git
cd cicd-pipeline
```

Run with Docker:
```bash
docker build -t cicd-pipeline:local .
docker run -p 3000:3000 cicd-pipeline:local
```

Open in browser:
- http://localhost:3000
- http://localhost:3000/health

Run tests locally (requires Node.js):
```bash
npm install
npm test
```

---

## Pull the Image from Docker Hub

The pipeline pushes the image to Docker Hub on every merge to main.
You can pull and run it directly without cloning the repo:

```bash
docker pull mohammedkhaiserulla/cicd-pipeline:latest
docker run -p 3000:3000 mohammedkhaiserulla/cicd-pipeline:latest
```

---

## CI/CD Pipeline Explained

The pipeline has two jobs that run in sequence.

### Job 1 — Test

Runs on every push and every pull request. Installs dependencies and runs Jest.
If any test fails this job turns red and Job 2 never starts. Broken code cannot
proceed further in the pipeline.

### Job 2 — Build and Push

Only runs when Job 1 passes AND the trigger is a push to main (not a pull request).
Logs into Docker Hub, builds the Docker image, and pushes it with two tags:

- `:latest` — always points to the most recently built image
- `:abc1234ef` — the exact Git commit hash that produced this image

In production teams the commit hash tag is what gets deployed — not `:latest`.
This gives you traceability. You can look at a running container, see its tag,
and trace it back to the exact line of code that was committed.

---

## GitHub Secrets Required

| Secret Name          | What It Is                          |
|----------------------|-------------------------------------|
| `DOCKERHUB_USERNAME` | Your Docker Hub username            |
| `DOCKERHUB_TOKEN`    | Docker Hub personal access token    |

Never put credentials directly in the pipeline file. The pipeline file is public.
Secrets are encrypted and injected at runtime by GitHub — they never appear in
logs or the file itself.

---

## Production Considerations

This project demonstrates the test and build stages of a CI/CD pipeline.
In a real production environment the pipeline would have additional stages:

**Deploy stage** — after pushing the image, the pipeline would SSH into a server
or trigger a Kubernetes rollout to deploy the new image. This project stops at
the image push stage. The deployment stage will be implemented in the Terraform
IaC project where a real server is provisioned first.

**Environment promotion** — production pipelines typically have multiple
environments: dev, staging, and production. Code goes through each environment
in sequence. Only after passing staging does it reach production.

**Rollback** — because every image is tagged with a Git commit hash, rolling
back is straightforward. You deploy the previous commit hash tag and the old
version is running again within seconds.

**Security scanning** — production pipelines include a step that scans the Docker
image for known vulnerabilities before pushing. Tools like Trivy or Snyk are
common choices. This would sit between the build and push steps.

---

## Tech Stack

- **Node.js 18** — LTS version, stable and security-patched
- **Express** — minimal web framework for Node.js
- **Jest + Supertest** — testing framework and HTTP testing utility
- **Docker** — containerisation
- **GitHub Actions** — CI/CD automation
- **Docker Hub** — container image registry