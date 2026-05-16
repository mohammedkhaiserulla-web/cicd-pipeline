# How This Project Works — Detailed Notes

These are my personal notes explaining how each part of this project works.
I wrote this while building the project so I do not forget the concepts and
can explain them confidently in interviews without hesitation.

---

## Table of Contents

1. [The Application Files](#1-the-application-files)
2. [package.json — The Project Manifest](#2-packagejson--the-project-manifest)
3. [The Dockerfile](#3-the-dockerfile)
4. [The CI/CD Pipeline](#4-the-cicd-pipeline)
5. [GitHub Secrets](#5-github-secrets)
6. [Docker Hub and Image Tags](#6-docker-hub-and-image-tags)
7. [Production Considerations](#7-production-considerations)

---

## 1. The Application Files

### Why three separate files instead of one

When I first looked at this I wondered why the app is split across `app.js`,
`server.js`, and `app.test.js` instead of putting everything in one file.
After understanding it properly, the reason is clean separation of concerns —
each file has one job and one job only.

### `src/app.js` — the application logic

This file creates the Express app and defines what happens when someone hits
each URL. It does not start the server. It does not listen on any port.
It just defines the logic and exports it so other files can use it.

```javascript
const express = require('express');
const app = express();

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Hello from cicd-pipeline' });
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy' });
});

module.exports = app;   // makes this app available to other files
```

The `module.exports = app` line at the bottom is critical. Without it, the
test file cannot import the app. It is like making a function public so it
can be called from outside the file.

The `/health` endpoint exists for a real reason — not just to have two routes.
In production, Kubernetes liveness probes, AWS load balancers, and monitoring
tools all periodically hit `/health` to check if the app is alive. If it returns
200 the app is healthy. If it does not respond the container gets restarted
automatically. Every production application I will ever work with will have
something like this.

### `src/server.js` — the startup file

This file imports the app from `app.js` and starts it listening on a port.
That is literally its only job.

```javascript
const app = require('./app');
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
```

`process.env.PORT || 3000` means — if an environment variable called PORT is
set, use that. Otherwise default to 3000. This is important for containers
because in production you might want to run the app on a different port without
changing the code. You just set the PORT environment variable when running the
container.

### Why the separation between `app.js` and `server.js` matters

The test file imports `app.js` directly — not `server.js`. This is deliberate.

If the test imported `server.js`, it would actually start the server on port 3000
every time tests run. That causes problems in CI environments where multiple test
runs might happen in parallel on the same machine — they would all fight over
port 3000 and fail.

By importing just `app.js`, the test file uses the app logic without starting
any real server. Supertest handles the fake HTTP requests internally without
needing a real port.

### `tests/app.test.js` — the test file

Jest runs this file when `npm test` is executed. It imports the app, sends fake
HTTP requests using Supertest, and checks that the responses are correct.

```javascript
const request = require('supertest');
const app = require('../src/app');

describe('API endpoints', () => {
  test('GET / returns status ok', async () => {
    const response = await request(app).get('/');
    expect(response.statusCode).toBe(200);
    expect(response.body.status).toBe('ok');
  });

  test('GET /health returns healthy', async () => {
    const response = await request(app).get('/health');
    expect(response.statusCode).toBe(200);
    expect(response.body.status).toBe('healthy');
  });
});
```

As a DevOps engineer I did not write these tests — the developer would write
them. My job is to make sure the pipeline runs them automatically on every push
and blocks deployment if they fail. That is exactly what this pipeline does.

---

## 2. package.json — The Project Manifest

This is one of the most important files for a DevOps engineer to understand
in any Node.js project. It is the single source of truth for what the project
is, what it depends on, and how to run it.

```json
"scripts": {
  "start": "node src/server.js",
  "test": "jest"
}
```

When the pipeline runs `npm test`, Node looks at this scripts section and
executes `jest`. When Docker runs `npm start` inside the container, it executes
`node src/server.js`. These are just shortcuts — aliases for longer commands.

```json
"dependencies": {
  "express": "^4.x.x"
},
"devDependencies": {
  "jest": "...",
  "supertest": "..."
}
```

The split between `dependencies` and `devDependencies` matters for Docker.
In the Dockerfile I run `npm install --omit=dev` which installs only
`dependencies` — express only. It skips jest and supertest entirely. There is
absolutely no reason to put testing libraries inside a production container.
Smaller image, less attack surface.

### node_modules

This folder contains the actual downloaded code of express, jest, supertest
and all of their own dependencies — 66 packages total. I never touch this folder
and never commit it to GitHub. It is listed in `.gitignore`.

Anyone who clones the repo and runs `npm install` will get the exact same
packages recreated from `package.json`. There is no need to store 66 packages
in Git when they can be regenerated in seconds.

---

## 3. The Dockerfile

```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY src/ ./src/
EXPOSE 3000
CMD ["node", "src/server.js"]
```

### Every line explained

`FROM node:18-alpine` — the base image. Alpine Linux is a minimal Linux
distribution that is only 5MB in size compared to 900MB for a full Ubuntu image.
We use Node.js 18 specifically because it is LTS (Long Term Support) — meaning
it receives security patches for years. Node.js 24 is newer but not LTS yet.
Production always uses LTS versions for stability.

`WORKDIR /app` — sets the working directory inside the container. Every command
that follows runs from inside `/app`. It is like doing `cd /app` but it also
creates the folder if it does not exist.

`COPY package*.json ./` — copies `package.json` and `package-lock.json` into
the container. Notice this is done before copying the actual app code. This is
a deliberate Docker layering optimisation explained below.

`RUN npm install --omit=dev` — installs only production dependencies inside
the container. The `--omit=dev` flag skips jest and supertest. Tests do not
run inside the production container — they run in the pipeline before the image
is even built.

`COPY src/ ./src/` — copies the application code into the container. This
happens after npm install for the caching reason explained below.

`EXPOSE 3000` — documents that the app inside the container listens on port
3000. This does not actually open the port. The port mapping happens when you
run the container with `-p 3000:3000` or in `docker-compose.yml`. EXPOSE is
documentation for humans and tools reading the Dockerfile.

`CMD ["node", "src/server.js"]` — the command that runs when the container
starts. This starts the Node.js server. There can only be one CMD in a Dockerfile.
If you override it with `--entrypoint` when running the container, CMD is ignored.

### Docker layer caching — why we copy package.json first

Docker builds images in layers. Each line in the Dockerfile is a layer. Docker
caches every layer. If a layer has not changed since the last build, Docker
reuses the cache instead of rebuilding it. This saves significant time.

```
Layer 1: FROM node:18-alpine          → never changes, always cached
Layer 2: WORKDIR /app                 → never changes, always cached
Layer 3: COPY package*.json           → only changes when you add/remove packages
Layer 4: RUN npm install              → only reruns if Layer 3 changed
Layer 5: COPY src/                    → changes every time you edit any code file
```

When I change one line in `app.js`, Docker only rebuilds from Layer 5 onwards.
Layers 1 through 4 are served from cache — including the entire `npm install`.
This saves 30 to 60 seconds on every build.

If I had written `COPY . .` instead of copying `package.json` separately, then
every code change would invalidate Layer 3, which would invalidate Layer 4,
which means Docker would run `npm install` from scratch every single time I
changed any line of code. Completely unnecessary and slow.

This ordering — copy manifest first, install dependencies, then copy code —
is a standard Docker best practice used in every production Dockerfile I will
ever see.

---

## 4. The CI/CD Pipeline

```yaml
name: CI/CD Pipeline

on:
  push:
    branches: [ main ]
  pull_request:
    branches: [ main ]
```

The pipeline is triggered on two events — a direct push to main, or a pull
request targeting main. Pull requests run the test job only. Direct pushes to
main run both jobs in sequence.

### Job 1 — Test

```yaml
  test:
    name: Run Tests
    runs-on: ubuntu-latest
    env:
      FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true
    steps:
      - uses: actions/checkout@v4.2.2

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '18'

      - name: Install dependencies
        run: npm install

      - name: Run tests
        run: npm test
```

`runs-on: ubuntu-latest` — GitHub spins up a completely fresh Ubuntu machine
for this job. Not my laptop. Not a shared server. A brand new machine that
exists only for the duration of this job and is destroyed after.

`env: FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true` — forces the GitHub Actions
runner to use Node.js 24 internally. This suppresses deprecation warnings about
actions that were built targeting Node.js 20.

`uses: actions/checkout@v4.2.2` — a pre-built action that clones my repository
onto that Ubuntu machine. Without this step the machine has no idea what my
code is. The `@v4.2.2` pins to an exact version. If I just wrote `@v4` and the
action author released a breaking change, my pipeline could break overnight
without me touching anything.

`uses: actions/setup-node@v4` — installs Node.js 18 on that Ubuntu machine.
The machine starts with nothing. Every tool needed must be explicitly installed.

`run: npm install` — installs all dependencies including devDependencies because
we need jest to run the tests. This is different from the Dockerfile where we
used `--omit=dev`. In the pipeline we need the test tools. In the container we
do not.

`run: npm test` — runs Jest. If any test fails this step exits with a non-zero
code, the job turns red, and Job 2 never starts. This is the gate that prevents
broken code from being built into a Docker image.

### Job 2 — Build and Push

```yaml
  build-and-push:
    name: Build and Push Docker Image
    runs-on: ubuntu-latest
    env:
      FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true
    needs: test
    if: github.ref == 'refs/heads/main' && github.event_name == 'push'
```

`needs: test` — this job waits for the test job to complete successfully before
starting. If the test job fails or is skipped, this job never runs. This is what
creates the sequential gate — test must pass before build happens.

`if: github.ref == 'refs/heads/main' && github.event_name == 'push'` — an extra
condition on top of `needs`. Even if tests pass, this job only runs when the
trigger was an actual push to main — not a pull request. This means pull requests
run tests but never push images to Docker Hub. Only merged, approved code that
lands on main gets built and shipped.

```yaml
      - name: Login to Docker Hub
        uses: docker/login-action@v3.4.0
        with:
          username: ${{ secrets.DOCKERHUB_USERNAME }}
          password: ${{ secrets.DOCKERHUB_TOKEN }}
```

Logs into Docker Hub using credentials injected from GitHub Secrets at runtime.
The actual values never appear in logs or in this file. The Ubuntu machine is
now authenticated to push images.

```yaml
      - name: Build and push
        uses: docker/build-push-action@v6
        with:
          context: .
          push: true
          tags: |
            ${{ secrets.DOCKERHUB_USERNAME }}/cicd-pipeline:latest
            ${{ secrets.DOCKERHUB_USERNAME }}/cicd-pipeline:${{ github.sha }}
```

`context: .` — use the current folder as the Docker build context. Same as
running `docker build .` locally.

`push: true` — after building, push the image to Docker Hub.

`tags` — the image gets two tags simultaneously:

`:latest` — always points to the most recently built image. Convenient for
pulling the newest version quickly.

`:${{ github.sha }}` — the full Git commit hash that triggered this pipeline
run. Something like `:a3f8c2d1e4b5...`. Every single push to main produces a
uniquely tagged image that can be traced back to the exact commit that built it.

In production teams the commit hash tag is what gets deployed to servers —
never `:latest`. If something goes wrong in production you look at the running
container, see its tag, and you know exactly which commit caused the problem.
Rolling back is as simple as deploying the previous commit hash tag.

---

## 5. GitHub Secrets

Credentials are never written directly in pipeline files. The pipeline file is
public — anyone on the internet can read it. If I put my Docker Hub password
there directly, anyone could log into my Docker Hub account.

GitHub Secrets are encrypted values stored on GitHub's servers. In the pipeline
I reference them as `${{ secrets.SECRET_NAME }}`. GitHub injects the real value
at runtime. The value never appears in logs. Even if you try to echo a secret
in a pipeline step, GitHub replaces it with asterisks in the output.

This is the same principle as environment variables in production — credentials
are never hardcoded, always injected at runtime from a secrets manager like AWS
Secrets Manager, HashiCorp Vault, or Kubernetes Secrets.

---

## 6. Docker Hub and Image Tags

After every push to main, my pipeline pushes the built image to Docker Hub at:

```
mohammedkhaiserulla/cicd-pipeline:latest
mohammedkhaiserulla/cicd-pipeline:<commit-hash>
```

Anyone with Docker installed can pull and run this image without cloning the repo:

```bash
docker pull mohammedkhaiserulla/cicd-pipeline:latest
docker run -p 3000:3000 mohammedkhaiserulla/cicd-pipeline:latest
```

This is exactly how production deployments work. A server does not clone the
Git repo and run the code directly. It pulls a versioned Docker image from a
registry and runs it. The registry is the source of truth for what is deployed.

In production the registry would be a private one — AWS ECR (Elastic Container
Registry), Google Artifact Registry, or a self-hosted Harbor registry. Docker
Hub is the public equivalent and is perfectly appropriate for a portfolio project.

---

## 7. Production Considerations

### What this pipeline is missing compared to real production

**Deployment stage** — this pipeline stops after pushing the image to Docker Hub.
In production the pipeline would continue and deploy the image to a server. This
would involve SSHing into an EC2 instance and pulling the new image, or triggering
a Kubernetes rollout with the new image tag. I will implement this in the
Terraform project where I provision a real server first.

**Environment promotion** — production pipelines have multiple environments. A
typical flow is: push to dev branch → deploys to dev environment → tested →
merged to staging → deploys to staging → tested → merged to main → deploys to
production. Each environment is a gate. Breaking code is caught before it reaches
users.

**Image vulnerability scanning** — before pushing the image to the registry, a
real pipeline would scan it for known security vulnerabilities using a tool like
Trivy or Snyk. If critical vulnerabilities are found the pipeline fails and the
image is not pushed. This step would sit between build and push.

**Notifications** — when a pipeline fails in production, the team gets notified
immediately via Slack or email. Nobody is manually watching the GitHub Actions
tab. GitHub Actions supports sending notifications through webhooks which can
integrate with any alerting system.

### The full production picture

```
Developer pushes code
       ↓
Tests run automatically
       ↓
Image is scanned for vulnerabilities
       ↓
Image is built and pushed to private registry (AWS ECR)
       ↓
Pipeline deploys to dev environment
       ↓
QA team tests on dev
       ↓
Merge to staging → auto deploy to staging
       ↓
Final approval → merge to main → auto deploy to production
       ↓
Monitoring alerts if anything breaks after deploy
       ↓
Rollback by redeploying previous commit hash tag
```

Every step is automated. The developer pushes code and the pipeline takes it
all the way to production without any manual intervention except approvals.
That is the goal of a mature CI/CD pipeline.