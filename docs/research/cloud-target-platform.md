# Cloud target platform for agent containers

Research for GitHub issue #2 ("Cloud target platform"), reopened, part of the spec effort for a
cloud platform that runs Claude Code / Claude Agent SDK agents in containers, scoped to this
single repo (no multi-tenant design needed).

**Container model assumed:** spin up a fresh container, run one agent session (minutes to tens
of minutes), tear down. Not a long-lived request-serving service. No idle/warm pool required.
Secrets are injected once at container start; the container is not expected to accept new
requests mid-life.

## What changed since the prior version

The prior version of this doc compared only five options — AWS Fargate/ECS, Fly Machines,
Modal, E2B, and self-hosted Docker + Firecracker/gVisor — and recommended E2B, with Modal as a
close second. It is being redone because (a) **Google Cloud Run was missed entirely** from the
original sweep, and (b) the search was too narrow generally. This redo:

- Re-verified all five original options against live, current (August 2026) primary sources.
  **No pricing numbers changed materially for any of the five.** E2B's own marketing has
  sharpened toward "The Enterprise AI Agent Cloud" branding (strengthens its positioning
  argument); Modal's and gVisor's "untrusted/agent code" doc language was re-confirmed with
  more precise citations.
- Added **Google Cloud Run Jobs** (the batch/execution primitive, not Cloud Run's
  request-serving "services" mode) — a strong contender, previously missing entirely.
- Broadened the "cloud-managed general compute" category with **Azure Container Instances** and
  **Northflank** (both genuine contenders), and checked **Railway**, **Koyeb**, and
  **Cloudflare Containers** (all excluded as misfits — no ephemeral run-to-completion job
  primitive that fits this workload shape).
- Broadened the "AI-sandbox-purpose-built" category with **Daytona**, **Vercel Sandbox**,
  **Blaxel**, **Runloop**, and **Deno Sandbox** (a beta product surfaced by open-ended search,
  not on the original candidate list).
- Added **GitHub Actions** (GitHub-hosted runners, and self-hosted/ephemeral runners via
  `actions-runner-controller`) at a collaborator's request, since this repo already lives on
  GitHub — evaluated under "CI-native" as its own category, since it isn't shaped like the other
  two groups.

**Net effect on the recommendation: confirmed, not changed.** E2B remains the primary pick and
Modal the close second. Cloud Run Jobs and GitHub Actions are both genuinely competitive on cost
and ops-burden and are called out explicitly as strong pragmatic alternatives if the team is
already GCP-native or wants to avoid standing up a new vendor relationship — but neither displaces
E2B on the "vendor documentation explicitly targets untrusted/agent-driven code execution as the
product's core threat model" criterion, which is the deciding factor for this ticket. See
[Recommendation](#recommendation) for full reasoning.

**Method:** primary sources only — vendor pricing pages, official docs, API/SDK reference,
upstream project docs (Firecracker, gVisor). Each material claim is cited inline. Claims found
only in blog posts, news articles, or forum threads were either traced back to the vendor's own
documentation and cited there, or dropped.

---

# Cloud-managed general compute

## AWS Fargate / ECS

**Cost.** Unchanged from the prior version: per-second billing per resource dimension, **1-minute
minimum** for Linux tasks. Linux/x86 (us-east-1): $0.000011244/vCPU-second,
$0.000001235/GB-second memory; 20 GB ephemeral storage included free.
([AWS Fargate Pricing](https://aws.amazon.com/fargate/pricing/)) A 5-minute run at 1 vCPU + 2 GB
≈ 300s × ($0.000011244 + 2×$0.000001235) ≈ **$0.0041**. No idle cost — Fargate only bills while a
task is running.

**Ops burden.** Unchanged: a registered **task definition** (image, CPU/memory, IAM roles, log
config), a **cluster**, and `awsvpc` **subnets/security groups** for `run-task`.
([ECS run-task CLI reference](https://docs.aws.amazon.com/cli/latest/reference/ecs/run-task.html))
Env vars via `--overrides` `containerOverrides[].environment`; logs need an `awslogs`
`logConfiguration` block plus an IAM role with `logs:CreateLogStream`/`logs:PutLogEvents`.
([Send ECS logs to CloudWatch](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/using_awslogs.html))
New note: **AWS Batch on Fargate** exists as an optional orchestration layer with built-in job
queuing/retry/array-job semantics on top of Fargate compute — it doesn't reduce the underlying
setup, it adds job-queue/compute-environment configuration on top, so it's worth knowing about but
doesn't change the core assessment.
([AWS Batch multi-container job scenarios](https://docs.aws.amazon.com/batch/latest/userguide/multi-container-jobs-scenarios.html))

**Isolation.** Confirmed unchanged, verbatim: "Each Fargate task has its own isolation boundary
and does not share the underlying kernel, CPU resources, memory resources, or elastic network
interface with another task."
([AWS docs: Architect for AWS Fargate](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/AWS_Fargate.html))
Firecracker-backed, VM-level isolation — AWS's strongest documented container isolation tier —
but Fargate itself carries no "agent/untrusted-code sandbox" framing in its own docs; the
isolation is a side effect of the general-purpose container platform, not a stated design goal.

**Secrets/env injection.** Unchanged: `environment` key/value pairs, plus a `secrets` field
pulling from Secrets Manager/SSM Parameter Store by ARN at container start.
([ECS task definition parameters / secrets](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/specifying-environment-files.html))
More moving parts (ARNs, IAM read permissions) than the "pass a dict at creation time" pattern
used by the AI-sandbox-purpose-built options.

---

## Google Cloud Run Jobs

Cloud Run Jobs is explicitly the batch/execution primitive, distinct from Cloud Run's
request-serving "services" mode: "A Cloud Run job only runs its tasks and exits when finished. A
job does not listen for or serve requests." Supports up to 10,000 parallel tasks and a
`--task-timeout` up to 168 hours.
([Cloud Run: Create jobs](https://docs.cloud.google.com/run/docs/create-jobs))

**Cost.** Tier 1 regions: $0.00002400/vCPU-second, $0.00000250/GiB-second beyond the free tier
(180,000 vCPU-seconds + 360,000 GiB-seconds + 2M requests/month free); Tier 2 regions:
$0.00003360/vCPU-second, $0.00000350/GiB-second. Billing rounds up to the nearest 100ms.
([Cloud Run pricing](https://cloud.google.com/run/pricing)) A 5-minute run at 1 vCPU/2 GB (Tier
1) ≈ 300s × ($0.000024 + 2×$0.0000025) ≈ **$0.0087**. No charge when nothing is executing.

**Ops burden.** `gcloud run jobs create JOB --image IMAGE` defines the job; execute via
`gcloud run jobs execute JOB --wait --tail` or the `jobs.run` REST endpoint; per-execution
overrides (including env vars) are passed at execution time via `--update-env-vars` / the REST
body without touching the stored job definition.
([Cloud Run: Execute jobs](https://docs.cloud.google.com/run/docs/execute/jobs)) Logs auto-ship
to Cloud Logging; execution status (Running/Succeeded/Failed/Cancelled) is queryable via
console/CLI. Low burden — a GCP project + billing account is the main prerequisite, no VPC or
cluster required for the basic path.

**Isolation.** Two execution environments are available: **gen1**, sandboxed with the **gVisor**
container runtime (namespace + seccomp isolation), and **gen2**, "Linux microVMs" described as a
"hardware-backed layer equivalent to individual VMs (x86 virtualization)."
([Cloud Run container contract](https://docs.cloud.google.com/run/docs/container-contract);
[Cloud Run security](https://docs.cloud.google.com/run/docs/securing/security)) Separately, Cloud
Run has a distinct **Code Execution / Sandboxes** feature explicitly documented for untrusted/
agent code: "AI agents can leverage sandboxes to safely run sub-agents, perform computational
tasks... in a fast, isolated environment without risking the host system," with no access to the
parent's env vars/secrets/metadata server by default and outbound network blocked by default.
([Cloud Run: Code execution](https://docs.cloud.google.com/run/docs/code-execution)) **Important
nuance:** this Sandboxes feature is a *nested* execution primitive invoked from within a Cloud
Run service/job — not a description of the Job container itself. The Job primitive evaluated here
(gen2 microVMs) is a strong general isolation boundary, but Google's own "designed for untrusted/
agent code" language attaches to the nested Sandboxes feature, not to Jobs directly.

**Secrets/env injection.** `--set-env-vars` / `--update-env-vars` for plain values; Secret
Manager values injected as env vars resolved at instance startup via
`--update-secrets=VAR=SECRET:VERSION` (Google recommends pinning a version rather than `latest`).
([Cloud Run: Configure secrets](https://docs.cloud.google.com/run/docs/configuring/services/secrets))

---

## Azure Container Instances (ACI)

**Cost.** Per the official Azure Retail Prices API (East US): Standard vCPU Duration =
$0.0405/hour (≈$0.00001125/vCPU-second); Standard Memory Duration = $0.00445/GB-hour
(≈$0.0000012361/GB-second). No published free tier. Billed by the second from image-pull start
until the container group is stopped; nothing once stopped.
([Azure Container Instances pricing](https://azure.microsoft.com/en-us/pricing/details/container-instances/);
[Azure Retail Prices API](https://prices.azure.com/api/retail/prices)) A 5-minute run at 1
vCPU/2 GB ≈ 300s × ($0.00001125 + 2×$0.0000012361) ≈ **$0.0041** — essentially identical to
Fargate.

**Ops burden.** `az container create` with image + env vars is the whole invocation; logs via
`az container logs` or streamed live via `az container attach`; status/events via
`az container show`.
([Get logs and metrics for ACI](https://learn.microsoft.com/en-us/azure/container-instances/container-instances-get-logs))
No VNet required for the basic path — comparable in weight to Fly Machines, lighter than Fargate.

**Isolation.** "Azure Container Instances guarantees your application is as isolated in a
container as it would be in a VM" — hypervisor-level ("hardware-backed") isolation per instance,
not shared-kernel container isolation; privileged operations are disallowed.
([ACI overview](https://learn.microsoft.com/en-us/azure/container-instances/container-instances-overview))
No "untrusted/agent code" framing found anywhere in ACI's own docs — it's positioned purely as
general-purpose serverless containers, not an AI-sandbox product.

**Secrets/env injection.** Plain env vars via `--environment-variables`; sensitive values via
`--secure-environment-variables` (`secureValue` in YAML), redacted from portal/CLI display.
(Microsoft Learn: container-instances-environment-variables)

---

## Fly Machines

**Cost.** Confirmed unchanged: per-second billing while running; stopped machines incur only
rootfs storage cost ($0.15/GB/30 days), no compute charge. Example: Performance-1x/2GB =
$0.00001242/s. ([Fly.io Pricing](https://fly.io/docs/about/pricing/)) A 5-minute run ≈ 300s ×
$0.00001242 ≈ **$0.0037**.

**Ops burden.** Confirmed unchanged: `fly machine run` creates the app/image/machine in one
command; stop (`POST .../stop`) and destroy (`DELETE .../`) are single REST calls.
([fly machine run reference](https://fly.io/docs/machines/flyctl/fly-machine-run/);
[Fly Machines API](https://fly.io/docs/machines/api/machines-resource/)) Logs via a documented
HTTP API (`GET /api/v1/apps/:app_name/logs`), up to ~7 days retained.
([Fly.io: Logs API options](https://fly.io/docs/monitoring/logs-api-options/)) Lightest managed
footprint among the general-VM options.

**Isolation.** Confirmed unchanged: "Fly Machines are Firecracker VMs," the same microVM tech
behind AWS Lambda. ([Fly.io: What Is a Firecracker VM?](https://fly.io/learn/firecracker-vm/);
[Fly Machines product page](https://fly.io/machines/)) VM-level isolation, same tier as
Fargate/ACI. No explicit "untrusted/agent code" product framing.

**Secrets/env injection.** Confirmed unchanged: `--env` flags for plain vars at machine-create
time; sensitive values via `fly secrets set` (encrypted vault), attached via
`--file-secret /path=SECRET_NAME`. Current docs are slightly more explicit than before: "For
sensitive environment variables, set secrets on the app instead."
([fly machine run reference](https://fly.io/docs/machines/flyctl/fly-machine-run/))

---

## Northflank

Northflank has an explicit **Jobs** resource, distinct from its always-on Services, runnable
manually or on a schedule via a documented REST API.

**Cost.** $0.01667/vCPU/hour, $0.00833/GB/hour, pro-rated to the second. Sandbox (free) tier
includes 2 free services + 2 free cron jobs for testing.
([Northflank pricing](https://northflank.com/pricing)) A 5-minute run at 1 vCPU/2 GB ≈
(300/3600) × ($0.01667 + 2×$0.00833) ≈ **$0.0028** — the cheapest of the general-compute options
evaluated. No idle charge stated beyond active run duration.

**Ops burden.** `POST /project/jobs/run-job` triggers a run programmatically, with per-run env
var overrides supported ("add new environment variables for the run, or override values... for
the current run only"); `GET /project/jobs/get-job-logs` and `get-run-details` retrieve
logs/status; `DELETE /project/jobs/abort-job-run` cancels a run.
([Northflank API introduction](https://northflank.com/docs/v1/api/introduction);
[Run an image once or on a schedule](https://northflank.com/docs/v1/application/run/run-an-image-once-or-on-a-schedule))
Full API-driven lifecycle, moderate-low burden, but requires standing up a Northflank
project/account.

**Isolation.** Standard Jobs run as regular containers on Northflank's Kubernetes-based
platform — container-level isolation, nothing stronger by default. Northflank separately sells a
dedicated **Sandboxes** product using "microVM-based virtualization and user-space kernel
isolation," explicitly "ideal for running untrusted code like LLM-generated code,
user-submitted code, AI agents, and CI/CD pipelines," booting in under 1 second.
([Northflank: Sandboxes](https://northflank.com/docs/v1/application/sandboxes/sandboxes-on-northflank))
Same nuance as Cloud Run: the vendor's "untrusted/agent code" language attaches to a distinct
Sandboxes product, not to the plain Jobs primitive evaluated for cost/ops above.

**Secrets/env injection.** Env vars/secrets set at job creation, override-able per run through
the same runtime-environment API endpoints noted under ops burden.

---

# AI-sandbox-purpose-built

## E2B

**Cost.** Confirmed unchanged: default 2-vCPU sandbox $0.000028/s CPU (1 vCPU = $0.000014/s,
scaling to 8 vCPU = $0.000112/s), plus $0.0000045/GiB-second memory.
([E2B Pricing](https://e2b.dev/pricing)) A 5-minute default (2 vCPU, 2 GiB) sandbox ≈ 300s ×
($0.000028 + 2×$0.0000045) ≈ **$0.0111**. Hobby tier: one-time $100 usage credit, no card
required; Pro: $150/month plus usage.

**Ops burden.** Confirmed unchanged: API key + `Sandbox.create()` SDK call is the entire setup.
([E2B docs: Quickstart](https://docs.e2b.dev/quickstart)) Custom environments built from a
Dockerfile via `e2b build` (Debian-based images only), producing a template ID used to start
sandboxes. Run output comes directly off the SDK's execution object rather than a separate logs
API. Lowest ops burden among general-purpose options.

**Isolation.** Confirmed and now more strongly documented: "Every E2B sandbox runs in its own
Firecracker microVM. Own kernel, own memory, own page cache," and Firecracker is described as
"a microVM made to run untrusted workflows." Duration limits confirmed: **1 hour on the
Base/Hobby tier, 24 hours on Pro**, with pause/resume state preservation beyond that.
([E2B docs: Sandbox](https://docs.e2b.dev/sandbox)) VM-level isolation, same tier as
Fargate/Fly/ACI, plus the Firecracker "jailer" for defense-in-depth. **Positioning has sharpened
since the prior version**: E2B's own homepage now brands the product "**The Enterprise AI Agent
Cloud**" ([e2b.dev](https://e2b.dev/)) — an even more explicit agent-code framing than before.

**Secrets/env injection.** Confirmed unchanged: `Sandbox.create({ envs: { MY_VAR: 'my_value' } })`
(JS) / `Sandbox.create(envs={'MY_VAR': 'my_value'})` (Python) sets env vars at creation time;
E2B also auto-injects `E2B_SANDBOX`, `E2B_SANDBOX_ID`, `E2B_TEMPLATE_ID` metadata.
([E2B docs: Environment variables](https://docs.e2b.dev/sandbox/environment-variables))

---

## Modal

**Cost.** Confirmed unchanged: standard $0.0000131/core-second + $0.00000222/GiB-second; Sandbox
tier (the relevant tier for this workload) $0.00003942/core-second + $0.00000667/GiB-second.
([Modal Pricing](https://modal.com/pricing)) A 5-minute sandbox run at 1 core + 2 GiB ≈ 300s ×
($0.00003942 + 2×$0.00000667) ≈ **$0.0158**. Starter tier: $30/month free credits, no minimum
purchase; Team tier: $100/month free credits.

**Ops burden.** Confirmed unchanged: `pip install modal` + `modal setup` is the entire
authentication setup — no cluster, VPC, or Kubernetes to manage.
([Modal: Getting started](https://modal.com/docs/guide)) Custom images built directly from an
existing Dockerfile via `modal.Image.from_dockerfile(...)`.
([Modal docs: Using existing images](https://modal.com/docs/guide/existing-images)) Sandboxes
created (`modal.Sandbox.create(...)`) and torn down (`sb.terminate()`/`sb.detach()`) or
automatically on timeout/OOM/entrypoint exit.
([Modal docs: Sandboxes](https://modal.com/docs/guide/sandboxes))

**Isolation.** Re-confirmed directly from current Sandbox docs: "secure containers for executing
untrusted user or agent code," with explicit named use cases — "Execute code generated by a
language model" and "Create isolated environments for running untrusted code."
([Modal docs: Sandboxes](https://modal.com/docs/guide/sandbox)) The gVisor implementation detail
from the prior version ("gVisor has custom logic to prevent Sandboxes from making malicious
system calls") is Modal's documented sandboxing tech; sandboxes default to no inbound network,
outbound-only by default with optional CIDR/domain allowlisting.
([Modal docs: Networking and security](https://modal.com/docs/guide/sandbox-networking)) This is
gVisor's syscall-interception model — container-level-plus-syscall-filtering rather than a
hardware-virtualized microVM.

**Secrets/env injection.** Confirmed unchanged: `modal.Secret.from_dict({"MY_SECRET": "hello"})`
passed via `secrets=[...]` to `Sandbox.create(...)`.
([Modal docs: Sandboxes](https://modal.com/docs/guide/sandbox))

---

## Daytona

**Cost.** Per-second billing: $0.0504/vCPU-hour, $0.0162/GiB-hour memory, $0.000108/GiB-hour
storage (first 5 GB free). ([Daytona Pricing](https://www.daytona.io/pricing)) A 5-minute run at
2 vCPU/4 GB ≈ 300s × (2×$0.0504/3600 + 4×$0.0162/3600) ≈ **$0.0102**. $200 free credit, no card
required; no idle charge stated for stopped sandboxes.

**Ops burden.** SDK/API-driven creation. Secrets are referenced by name from pre-created,
org-level Secret objects rather than passed inline as raw values — an extra provisioning step
compared to E2B/Modal's inline env-dict pattern.
([Daytona Sandboxes docs](https://www.daytona.io/docs/en/sandboxes/))

**Isolation.** Tiered by sandbox class: the default **container-class** sandbox is "isolated
container with dedicated namespaces + cgroups" (container-level only); a separate **VM
sandbox class** offers "full virtual machine with its own kernel."
([Daytona: Isolation](https://www.daytona.io/docs/en/isolation/)) No explicit
"untrusted/agent code" language in the isolation doc itself (unlike E2B/Modal/Vercel/Blaxel),
despite Daytona's marketing elsewhere describing the product as infrastructure for
"AI-generated code." Matching E2B/Modal's isolation tier requires explicitly choosing the VM
class, not the default.

**Secrets/env injection.** `secrets` parameter maps an env-var name to a pre-created Secret name;
Daytona's outbound proxy substitutes the real value only at egress to allowed hosts, so the
plaintext value never enters the sandbox process. Plain `env` vars remain available for
non-sensitive values. ([Daytona docs](https://www.daytona.io/docs/en/sandboxes/))

---

## Vercel Sandbox

**Cost.** Metered: Active CPU $0.128/hour, Provisioned Memory $0.0212/GB-hour (1-minute
minimum), $0.60 per 1M sandbox creations, network egress $0.15/GB. Vercel's own worked example
for "AI code validation, 5 min, 2 vCPU/4GB" comes to **≈$0.03**.
([Vercel Sandbox pricing](https://vercel.com/docs/sandbox/pricing)) No charge while stopped;
Hobby tier includes 5 free CPU-hours/month.

**Ops burden.** `Sandbox.create()` via JS/Python SDK or CLI, `sandbox.stop()` to tear down.
**Max session duration is capped: 45 minutes on Hobby, 24 hours on Pro+** — comfortably above
this workload's "minutes to tens of minutes," so not binding, but worth noting as a hard ceiling
on the Hobby tier. Concurrency and vCPU-allocation-rate quotas apply per plan.
([Vercel Sandbox docs](https://vercel.com/docs/sandbox))

**Isolation.** "Each sandbox runs in a secure Firecracker microVM with its own filesystem and
network." Docs explicitly state the product is designed "to safely run untrusted or
user-generated code," naming "AI agent output" as a use case.
([Vercel Sandbox docs](https://vercel.com/docs/sandbox)) VM-level isolation with an explicit
agent-code threat model — matches E2B's positioning closely.

**Secrets/env injection.** Env vars/secrets passed as creation-time SDK parameters; auth via
OIDC token or access token (full parameter-level detail confirmed present in the SDK reference,
though not exhaustively enumerated in this pass — verify exact parameter names against
`vercel.com/docs/sandbox` before implementation).

---

## Blaxel

**Cost.** $0.0000115/GB-RAM-second of active compute (e.g., an 8 GB sandbox ≈ $0.33/hour);
suspended/standby time is explicitly **not billed** ("stop paying for idle").
([Blaxel pricing](https://blaxel.ai/pricing)) A 5-minute run at ~4 GB ≈ 300s × 4 ×
$0.0000115 ≈ **$0.0138**. $200 free credit, no card required.

**Ops burden.** `SandboxInstance.createIfNotExists()` / `.delete()` SDK calls. Log-streaming is
mentioned in the docs, but the exact retrieval mechanics were not fully confirmed in this pass —
**flag this as needing a follow-up doc check** before relying on Blaxel for a "get logs"
workflow. ([Blaxel Sandboxes docs](https://docs.blaxel.ai/sandboxes/overview))

**Isolation.** Described by the vendor as "lightweight virtual machines" (not container/gVisor
framing), explicitly "designed to securely run LLM-generated code... with no risk of escaping."
([Blaxel Sandboxes docs](https://docs.blaxel.ai/sandboxes/overview)) VM-level isolation with an
explicit agent-code threat model.

**Secrets/env injection.** Plain `envs` array at creation for non-sensitive vars; secrets
recommended via a **Blaxel proxy** that intercepts outbound HTTPS and substitutes
`{{SECRET:name}}` placeholders server-side, so the real value never lives in the sandbox process —
the same "proxy substitution" pattern as Daytona.
([Blaxel: Variables and secrets](https://docs.blaxel.ai/sandboxes/variables-and-secrets))

---

## Runloop

**Cost.** $0.108/CPU-hour, $0.0252/GB-hour memory, $0.00034236/GB-hour storage; Pro tier adds
$250/month. ([Runloop pricing](https://runloop.ai/pricing)) A 5-minute run at 2 vCPU/4 GB ≈
(300/3600) × (2×$0.108 + 4×$0.0252) ≈ **$0.045** — the most expensive of the AI-sandbox options
evaluated (Basic/free tier, before any subscription). $50 free credit. Suspended devboxes accrue
no compute charge.

**Ops burden.** `runloop.devbox.create()` to start, `devbox.shutdown()` to tear down,
`result.stdout()` for output. Straightforward, but suspend/resume and custom benchmarking are
gated behind the Pro tier.
([Runloop docs](https://docs.runloop.ai/docs/devboxes/overview))

**Isolation.** The vendor states only "we use virtual machine technology" — no specific mention
of Firecracker, gVisor, or a named microVM technology. Devboxes are positioned as where "AI
agents do their work," but without the explicit "untrusted code" security language used by
E2B/Modal/Vercel/Blaxel/Deno.

**Secrets/env injection.** `environment_variables` object in the devbox-create API body — a
plain mechanism, not a secrets-manager-backed proxy substitution like Daytona/Blaxel.

---

## Deno Sandbox

A beta product (announced February 2026), surfaced via open-ended search rather than being on
the original candidate list, and directly on-point for this ticket: "Deno's managed service for
running untrusted or AI-generated code," built on Firecracker microVMs with sub-second boot.
([Deno Sandbox docs](https://docs.deno.com/sandbox/);
[Deno blog: Introducing Deno Sandbox](https://deno.com/blog/introducing-deno-sandbox))

**Cost.** $0.05/CPU-hour, $0.016/GiB-hour memory, $0.20/GiB-month volume storage.
([Deno Deploy: Sandbox](https://deno.com/deploy/sandbox)) A 5-minute run at the 2 vCPU/1.2 GiB
default ≈ **$0.0035** — the cheapest of all AI-sandbox-purpose-built options evaluated.

**Ops burden.** `Sandbox.create()` via the `@deno/sandbox` SDK, with automatic teardown via an
`await using` context manager. **Caveat: maximum sandbox lifetime is capped at 30 minutes per
session** — comfortably within this workload's "minutes to tens of minutes" range, but a hard
ceiling worth flagging, and the product is still in beta (newer/less proven than E2B or Modal).

**Isolation.** Firecracker microVMs, explicitly "designed for running untrusted code" — the same
isolation tier as AWS Lambda/Fargate, with an explicit agent-code threat model matching E2B's and
Vercel's framing.

**Secrets/env injection.** A distinctive mechanism: `secrets: { KEY: { hosts: [...], value } }` —
the real value is substituted only on egress to allow-listed hosts and never appears inside the
sandbox process itself, a stronger default than plain env vars (matches the
Daytona/Blaxel proxy-substitution pattern, but built into the primary secrets API rather than a
separate proxy feature).

---

# CI-native

## GitHub Actions — GitHub-hosted runners

This repo already lives on GitHub, so the natural shape here is a `workflow_dispatch` (or
`repository_dispatch`)-triggered workflow that spins up a runner, runs the agent in a container
step, and tears down automatically at job end.

**Cost.** Billed per minute, rounded up. Current baseline rates: Linux 1-core x64 $0.002/min,
Linux 2-core x64 $0.006/min, Linux 2-core arm64 $0.005/min, Windows 2-core $0.010/min, macOS
3–4-core $0.062/min.
([GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions))
No idle charge — billing is "total processing time used by each runner type during the month."
A 5-minute run on a Linux 2-core x64 runner ≈ 5 × $0.006 = **$0.03**. Public repos get
GitHub-hosted runner minutes free regardless of usage.

**Ops burden.** A `workflow_dispatch` trigger in the workflow YAML is the entire job definition;
invoke via `gh workflow run` or `POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches`
(up to 25 JSON `inputs`).
([Manually running a workflow](https://docs.github.com/actions/managing-workflow-runs/manually-running-a-workflow))
Logs via `gh run view --log` or the REST API; teardown is automatic and implicit (GitHub tears
down the VM after the job). For hosted runners this is effectively **zero new infrastructure to
operate** — and since the repo is already on GitHub, there's no new vendor account/platform
relationship to establish at all, arguably the lowest "time to first run" of every option
evaluated.

**Isolation.** GitHub's own docs: "each GitHub-hosted runner is a new virtual machine (VM) hosted
by GitHub" — a fresh VM per job (caveat: "single-CPU runners are hosted in a container on a
shared VM," a lower isolation tier only at the smallest runner size).
([GitHub-hosted runners](https://docs.github.com/en/actions/concepts/runners/github-hosted-runners))
No "untrusted/agent code" product framing anywhere in these docs — this is generic CI/VM
isolation, not a sandboxing product, though the boundary itself (full VM) matches Fargate/Fly/ACI.

**Secrets/env injection.** Encrypted secrets at repo/environment/org level, referenced via the
`secrets` context (`${{ secrets.SuperSecret }}`) and typically mapped into step `env:` at job
start; values are redacted from logs automatically.
([Encrypted secrets](https://docs.github.com/en/actions/security-guides/encrypted-secrets))
Note: secrets are withheld on workflows triggered from forked repos (irrelevant here, since these
are `workflow_dispatch`/`repository_dispatch` runs on the repo's own workflows).

**Job time limit.** "Each job in a workflow can run for up to 6 hours of execution time"
(overall workflow-run limit is 35 days, covering queue/approval time).
([Usage limits](https://docs.github.com/en/actions/reference/limits)) Comfortably above this
workload's "minutes to tens of minutes" — not a binding constraint.

## GitHub Actions — self-hosted / ephemeral runners (excluded from serious consideration)

Self-hosted runners (including ephemeral ones autoscaled via `actions-runner-controller`, a
Kubernetes controller) trade away GitHub Actions' main advantage — zero infrastructure — for a
Kubernetes operational burden: standing up/maintaining a cluster, installing the controller and
its CRDs, and managing runner-scale-set lifecycle. GitHub's own security-hardening docs are
explicit that "self-hosted runners should almost never be used for public repositories on
GitHub, because any user can open pull requests against the repository and compromise the
environment" — a warning aimed at public-contributor/fork-PR threat models, not this ticket's
"repo owner's own agent runs" shape, so it isn't a hard blocker here. But the ops burden of
self-hosted/ARC is strictly worse than GitHub-hosted runners with no isolation or cost benefit at
this scale, so it is excluded from further evaluation.
([Security hardening for GitHub Actions](https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions))

**Competitive read:** for this single-repo, own-agent-runs use case, GitHub-hosted runners are a
legitimate, cheap, near-zero-ops contender — arguably the lowest ops burden of everything
evaluated, precisely because the repo is already on GitHub. It loses ground on two fronts: it's a
CI system repurposed for this, not a purpose-built agent-sandbox API (no pause/resume, no
fine-grained network-egress policy, no sub-second cold starts), and its isolation story is
generic-VM rather than an explicit "designed for untrusted/agent-driven code" claim the way
E2B/Modal/Vercel/Blaxel/Deno make. Worth a pilot for cost/convenience reasons, but not the primary
pick on the isolation criterion.

---

# Self-hosted

## Docker + Firecracker/gVisor

**Cost.** No vendor meter — cost is whatever compute is provisioned plus ops time. Firecracker
requires KVM access (Linux kernel ≥4.14, hardware virtualization), in practice bare-metal or
nested-virtualization-enabled instances.
([Firecracker microVM docs](https://firecracker-microvm.github.io/)) gVisor (`runsc`) does not
require KVM/bare metal — it runs as a standard OCI-compatible runtime on ordinary Linux hosts,
integrating directly with Docker/Kubernetes.
([gVisor docs](https://gvisor.dev/docs/)) Unless a custom scale-to-zero/autoscaling control
plane is also built, the host(s) are billed continuously between agent sessions — the opposite of
every managed option's true pay-per-execution model.

**Ops burden.** Highest of every option evaluated. Owning: host provisioning/patching,
installing/configuring the Firecracker VMM or `runsc` runtime (plus, for Firecracker, the
`jailer` companion process), a run/stop/teardown control plane (Firecracker exposes only a
low-level per-VM REST config API, not a fleet-management API), log capture/shipping, and
networking/security-group equivalents. None of this ships "out of the box" — it's the same
primitives every managed option in this doc already built and resells as an API.

**Isolation.** The only option where the isolation technology is self-chosen and self-configured.
Firecracker's microVM/KVM model matches the managed VM-tier options if configured correctly,
including the `jailer` hardening layer.
([Firecracker docs](https://firecracker-microvm.github.io/)) gVisor's Sentry/Gofer/`runsc` model
matches Modal's underlying isolation tier; gVisor's own docs are now more precisely quotable than
before: gVisor provides "a strong layer of isolation between running applications and the host
operating system" and is explicitly "designed for running untrusted workloads," sandboxing "to
minimize the risk of a container escape exploit."
([gVisor docs](https://gvisor.dev/docs/)) Neither upstream project's docs make a claim about a
*specific deployment* being secure by default — that assurance (network defaults, jailer usage,
patch cadence) is entirely on whoever operates it.

**Secrets/env injection.** No vendor-provided mechanism — writing env vars into the Firecracker
VM's boot config or a `runsc` container spec at launch time, plus custom secret-fetching logic,
is something to build.

---

# Excluded / misfit

Brief notes only — these were checked against the fit filter ("run one container per agent
session, inject secrets at start, get logs, tear down") and rejected before a full four-criteria
evaluation, since the mismatch is structural, not a matter of degree.

- **Railway** — the only "runs to completion" primitive is **Cron Jobs**, which are
  schedule-triggered only; Background Workers/Queue consumers are explicitly always-on
  persistent services. No documented API to trigger a single ad hoc run with fresh secrets
  per call. ([Railway: Cron jobs](https://docs.railway.com/cron-jobs);
  [Cron, workers, queues](https://docs.railway.com/guides/cron-workers-queues))
- **Koyeb** — service types are limited to **Web Service** (request-serving) and **Worker**
  (background tasks) — both are continuous, always-running services per Koyeb's own docs, with
  no distinct run-to-completion "Job" resource.
  ([Koyeb: Services reference](https://www.koyeb.com/docs/reference/services))
- **Cloudflare Containers** — architected as request/response backing for Workers: container
  instances are addressed and driven per-request/session by Worker code, with idle-shutdown
  (`sleepAfter`) rather than a "run once to completion and exit with status" batch primitive. No
  standalone job-invocation API. Isolation itself is VM-level ("each container instance runs
  inside its own VM"), but the mismatch is in execution shape, not isolation.
  ([Cloudflare Containers](https://developers.cloudflare.com/containers/))
- **GitHub Actions self-hosted/ARC** — see [above](#github-actions--self-hosted--ephemeral-runners-excluded-from-serious-consideration);
  structurally viable but strictly worse ops burden than GitHub-hosted runners for this workload,
  so excluded from full scoring.

---

# Comparison at a glance

| | Category | ~5-min cost (stated assumption) | Idle cost | Ops burden | Isolation | Vendor claims "untrusted/agent code" fit? |
|---|---|---|---|---|---|---|
| AWS Fargate/ECS | Cloud-managed | $0.0041 (1vCPU/2GB) | None | Moderate (task def, IAM, VPC, log group) | VM-level (Firecracker) | No |
| Google Cloud Run Jobs | Cloud-managed | $0.0087 (1vCPU/2GB) | None | Low (`gcloud run jobs`, GCP project) | gen1 gVisor / gen2 microVM | Only via separate nested Sandboxes feature, not Jobs itself |
| Azure Container Instances | Cloud-managed | $0.0041 (1vCPU/2GB) | None | Low-moderate (`az container`) | VM-level (hypervisor) | No |
| Fly Machines | Cloud-managed | $0.0037 (2GB perf-1x) | Storage only | Low (`fly machine run`) | VM-level (Firecracker) | No |
| Northflank Jobs | Cloud-managed | $0.0028 (1vCPU/2GB) | None | Low-moderate (REST API) | Container-level (Jobs); microVM only via separate Sandboxes product | Only via separate nested Sandboxes product |
| E2B | AI-sandbox | $0.0111 (2vCPU/2GiB) | None | Lowest (API key + SDK) | VM-level (Firecracker) | **Yes** — "Enterprise AI Agent Cloud" |
| Modal | AI-sandbox | $0.0158 (1 core/2GiB, sandbox tier) | None | Lowest (`pip install` + token) | gVisor (container+syscall-filter) | **Yes** — "untrusted user or agent code" |
| Daytona | AI-sandbox | $0.0102 (2vCPU/4GB) | None stated | Low (SDK; secrets need pre-provisioning) | Container-class default; VM-class optional | Marketing only, not in isolation docs |
| Vercel Sandbox | AI-sandbox | $0.03 (2vCPU/4GB, vendor example) | None | Low (SDK/CLI); session cap 45min–24h | VM-level (Firecracker) | **Yes** — "untrusted or user-generated code," "AI agent output" |
| Blaxel | AI-sandbox | $0.0138 (~4GB) | None (suspended = free) | Low (SDK); logs mechanism unclear | VM-level ("lightweight VMs") | **Yes** — "no risk of escaping" |
| Runloop | AI-sandbox | $0.045 (2vCPU/4GB) | None (suspended = free) | Low (SDK) | Unspecified "VM technology" | No explicit untrusted-code language |
| Deno Sandbox (beta) | AI-sandbox | $0.0035 (2vCPU/1.2GiB default) | None | Low (SDK); 30-min session cap; beta | VM-level (Firecracker) | **Yes** — "untrusted or AI-generated code" |
| GitHub Actions (hosted) | CI-native | $0.03 (2-core Linux) | None | Lowest (already on GitHub) | Full VM per job | No (generic CI framing) |
| Self-hosted Firecracker/gVisor | Self-hosted | Raw compute only | Yes, unless custom autoscaling | Highest | Same tech as managed options, self-configured | N/A — you decide |

---

# Recommendation

**Primary pick: E2B. Close second: Modal.** This confirms the prior version's recommendation —
neither Cloud Run Jobs nor any of the newly-surfaced contenders (Vercel Sandbox, Deno Sandbox,
Blaxel, Daytona, Runloop, Northflank, GitHub Actions) changes the pick, for reasons tied to the
four criteria:

1. **Cost** — E2B (~$0.011/5min) and Modal (~$0.016/5min) sit in the same order of magnitude as
   every viable option; Northflank, Fly Machines, Deno Sandbox, and Fargate/ACI are all cheaper
   in raw dollar terms, but the spread across every option here (roughly $0.003–$0.045 per
   5-minute run) is immaterial at this workload's scale. Cost does not meaningfully discriminate
   between contenders.
2. **Ops burden** — E2B and Modal remain the lowest-friction options: an API key/token and one
   SDK call is the entire setup, no cluster/VPC/IAM to stand up. GitHub Actions is competitive
   here too — arguably lower, since the repo is already on GitHub — but its lifecycle is
   CI-run-shaped (YAML workflow + dispatch event) rather than a direct sandbox-lifecycle API
   (create/exec/terminate), which matters less for ops burden but more for programmatic control
   over agent sessions.
3. **Isolation** — this is the deciding criterion. E2B (Firecracker microVMs, "The Enterprise AI
   Agent Cloud") and Modal (gVisor, "untrusted user or agent code," "execute code generated by a
   language model") are the two options whose vendor documentation makes the most direct,
   long-standing, product-level claim of being built for exactly this ticket's threat model.
   Vercel Sandbox and Deno Sandbox now make comparably explicit claims and use the same
   Firecracker microVM technology as E2B — both are genuine peers on this axis — but Vercel
   Sandbox is costlier with a tighter session cap on its entry tier, and Deno Sandbox is a beta
   product (announced within the last several months) with a hard 30-minute session ceiling,
   making both slightly less mature choices than E2B today. Cloud Run Jobs and Northflank Jobs
   both have a directly relevant "designed for untrusted/agent code" capability *in their
   product family*, but that language attaches to a separate nested Sandboxes/Code-Execution
   feature, not to the Job primitive itself — so neither displaces E2B/Modal without adopting a
   different (and less-evaluated) sub-product. GitHub Actions' isolation (full VM per job) is
   structurally fine but carries no agent/untrusted-code framing at all — it's generic CI
   isolation.
4. **Secrets/env injection** — E2B's `envs` dict at `Sandbox.create()` remains the simplest
   "inject at container-start" mechanism evaluated, matching this ticket's exact requirement.
   Deno Sandbox's and Blaxel's/Daytona's proxy-substitution secret mechanisms are arguably
   *more* secure (the real value never enters the sandbox process), which is worth watching as
   those products mature, but adds a layer of indirection (host-allowlisting, pre-provisioned
   secret objects) not needed for a single-repo, single-operator setup.

**Practical alternatives worth keeping in mind, not displacing the primary pick:**

- **Cloud Run Jobs** is the strongest "if the team is already GCP-native" option — cheap, low-ops,
  and Google's own Sandboxes feature (nested within Cloud Run) is explicitly built for agent
  code, so adopting Cloud Run's broader product family is a reasonable path if GCP is already
  the org's cloud of choice. It does not currently beat E2B/Modal on the Jobs primitive alone.
- **GitHub Actions (hosted runners)** is the strongest "zero new vendor relationship" option,
  since the repo already lives on GitHub — worth a pilot for its near-zero setup cost, but its
  CI-shaped lifecycle and generic (non-agent-specific) isolation framing make it a pragmatic
  fallback rather than the primary pick.
- **Vercel Sandbox** and **Deno Sandbox** are genuine emerging peers to E2B on isolation tech and
  positioning; revisit if E2B's pricing or terms change, or once Deno Sandbox exits beta.

Fly Machines remains a reasonable fallback if the team wants a more general "run any VM"
primitive outside the AI-sandbox product category, as noted in the prior version — its docs
still don't make the explicit "designed for agent/untrusted code" claim that E2B, Modal, Vercel
Sandbox, Blaxel, and Deno Sandbox do.
