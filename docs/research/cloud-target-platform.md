# Cloud target platform for agent containers

Research for GitHub issue #2 ("Cloud target platform"), part of the spec effort for a cloud
platform that runs Claude Code / Claude Agent SDK agents in containers, scoped to this single
repo (no multi-tenant design needed).

**Container model assumed:** spin up a fresh container, run one agent session (minutes to tens
of minutes), tear down. Not a long-lived service. No idle/warm pool required.

**Options compared:** AWS Fargate/ECS, Fly Machines, Modal, E2B, self-hosted Docker +
Firecracker/gVisor.

**Method:** primary sources only — vendor pricing pages, official docs, API/SDK reference,
upstream project docs (Firecracker, gVisor). Each claim below is cited inline. No blog posts or
secondary summaries are cited as evidence.

---

## 1. AWS Fargate / ECS

**Cost.** Fargate bills per second, per resource dimension (vCPU, memory, ephemeral storage),
with a **1-minute minimum** for Linux tasks (5-minute minimum for Windows). Linux/x86 rates
(us-east-1): $0.000011244 / vCPU-second, $0.000001235 / GB-second memory; 20 GB ephemeral
storage included free. ([AWS Fargate Pricing](https://aws.amazon.com/fargate/pricing/))
A 5-minute run at 1 vCPU + 2 GB memory ≈ 300s × ($0.000011244 + 2×$0.000001235) ≈ **$0.0041**.
No idle cost between runs — Fargate only bills while a task is running; there is no
cluster/control-plane charge on top for Fargate launch type.

**Ops burden.** Fargate removes server/cluster management ("you no longer have to provision,
configure, or scale clusters of Amazon EC2 instances") but you still assemble several AWS
primitives yourself: a registered **task definition** (container image, CPU/memory, IAM roles,
log config), a **cluster** (default one is auto-created), and for `awsvpc` networking, **VPC
subnets and security groups** are required parameters to `run-task`.
([AWS ECS run-task CLI reference](https://docs.aws.amazon.com/cli/latest/reference/ecs/run-task.html))
Per-run env vars are passed via `--overrides` `containerOverrides[].environment`; logs require
adding an `awslogs` `logConfiguration` block to the task definition and an IAM role with
`logs:CreateLogStream`/`logs:PutLogEvents`.
([Send Amazon ECS logs to CloudWatch](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/using_awslogs.html))
Net: fully managed compute, but meaningful one-time IaC (VPC, IAM roles, task definition, log
group) before you get a working "run container → get logs → tear down" loop.

**Isolation.** "Each Fargate task has its own isolation boundary and does not share the
underlying kernel, CPU resources, memory resources, or elastic network interface with another
task." ([AWS docs: Architect for AWS Fargate](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/AWS_Fargate.html))
Under the hood this boundary is implemented with the Firecracker VMM, which AWS describes as
purpose-built so "workloads from different end customers can run safely on the same machine."
([Firecracker microVM docs](https://firecracker-microvm.github.io/)) This is a VM-level
(microVM) isolation boundary, AWS's strongest documented container isolation tier — but Fargate
itself isn't marketed as an "agent/untrusted-code sandbox" product; you get the isolation as a
side effect of the general-purpose container platform.

**Secrets/env injection.** Two mechanisms: plain `environment` key/value pairs in the task
definition or `run-task --overrides`, and a `secrets` field that pulls values from Secrets
Manager or SSM Parameter Store by ARN at container start
(`{"name": "API_KEY", "valueFrom": "arn:aws:secretsmanager:..."}`).
([ECS task definition parameters / secrets](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/specifying-environment-files.html))
This is oriented around a registered task definition rather than a single ad hoc API call —
usable for per-run injection, but with more moving parts (ARNs, IAM permissions to read them)
than the other options' "pass a dict at creation time" pattern.

---

## 2. Fly Machines

**Cost.** Machines bill per second while running; stopped machines incur only storage charges
("Each 1GB of rootfs for a Machine stopped for 30 days is $0.15") — no compute charge when
stopped. Example rate: Performance-1x/2GB = $0.00001242/s (~$32.19/month if run continuously).
([Fly.io Pricing](https://fly.io/docs/about/pricing/)) A 5-minute run at that size ≈ 300s ×
$0.00001242 ≈ **$0.0037**. No published free compute allowance; volume/reservation discounts
(40% off) are available but not needed for this workload shape.

**Ops burden.** `fly machine run` creates the app (if it doesn't exist), builds/pulls the image,
and starts a machine in one command — no separate cluster or VPC step described in the docs.
([fly machine run reference](https://fly.io/docs/machines/flyctl/fly-machine-run/)) Stopping
(`POST .../stop`) and destroying (`DELETE .../`) are single REST calls.
([Fly Machines API: machines resource](https://fly.io/docs/machines/api/machines-resource/))
Logs are available via a documented HTTP API (`GET /api/v1/apps/:app_name/logs`, same one the
`fly logs` CLI uses) returning up to ~7 days of retained history, with NATS streaming and a log
shipper as additional options. ([Fly.io: Logs API options](https://fly.io/docs/monitoring/logs-api-options/))
Overall this is the lightest managed-infra footprint of the "general VM/container" options
(Fargate and self-hosted): one CLI/API call to run, one to stop/destroy, no VPC/subnet
provisioning called out as a prerequisite.

**Isolation.** "Fly Machines are Firecracker VMs" — the same microVM technology behind AWS
Lambda, giving "sub-second starts and stops with full VM control."
([Fly.io: What Is a Firecracker VM?](https://fly.io/learn/firecracker-vm/); confirmed in
[Fly Machines product page](https://fly.io/machines/)) This is the same VM-level isolation
tier as Fargate — hardware-virtualization-backed, not just a container/gVisor sandbox.

**Secrets/env injection.** `fly machine run . --env MY_VAR=MY_VALUE` sets plain env vars
directly at machine-create time; per the CLI docs, quote values containing spaces.
Sensitive values go through `fly secrets set` (must be Base64-encoded) and are attached via
`--file-secret /path=SECRET_NAME`, which fails machine creation if the value isn't
Base64-encoded. ([fly machine run reference](https://fly.io/docs/machines/flyctl/fly-machine-run/))
This is a simple, single-command mechanism for both plain and sensitive per-run values.

---

## 3. Modal

**Cost.** Billed per second of actual compute, no idle charges: "You never pay for idle
resources — just actual compute time, by the CPU cycle." Standard rate: $0.0000131/core-second,
$0.00000222/GiB-second memory (Sandbox tier is somewhat higher: $0.00003942/core-second,
$0.00000667/GiB-second). ([Modal Pricing](https://modal.com/pricing)) A 5-minute sandbox run at
1 core + 2 GiB ≈ 300s × ($0.00003942 + 2×$0.00000667) ≈ **$0.0158** (sandbox-tier rate). Starter
accounts get $30/month in free compute credit, no minimum purchase.

**Ops burden.** No cluster or VPC to provision: `pip install modal` + `modal setup` for
authentication is the entire setup — "you don't have to set up any infrastructure" and "you
don't need to mess with Kubernetes, Docker, or even an AWS account."
([Modal: Getting started](https://modal.com/docs/guide)) A custom container image can be built
directly from an existing Dockerfile via `modal.Image.from_dockerfile("Dockerfile")` (Modal has
its own Dockerfile-spec implementation, not literal `docker build`).
([Modal docs: Using existing images](https://modal.com/docs/guide/existing-images)) Sandboxes
are created (`modal.Sandbox.create(...)`) and torn down programmatically
(`sb.terminate()`/`sb.detach()`) or automatically on timeout/OOM/entrypoint exit.
([Modal docs: Sandboxes](https://modal.com/docs/guide/sandboxes)) This is the lowest-ops option
of the five for a "run one container, get output, tear down" workflow — no IaC beyond
application code.

**Isolation.** Modal Sandboxes are explicitly positioned as "secure containers for executing
untrusted user or agent code on Modal," using gVisor: "gVisor has custom logic to prevent
Sandboxes from making malicious system calls, giving stronger isolation than most other
container runtimes," implementing "a virtualization layer between applications and the host
operating system" that "creates a strong layer of isolation and implements the Linux kernel in
userspace." Sandboxes default to no inbound network access and only outbound-by-default, with
optional CIDR/domain allowlisting. ([Modal docs: Sandboxes](https://modal.com/docs/guide/sandbox);
[Modal docs: Networking and security](https://modal.com/docs/guide/sandbox-networking)) This is
gVisor's syscall-interception model — a strong sandboxing boundary, but architecturally
container-level-plus-syscall-filtering rather than hardware-virtualized microVM (see gVisor
notes under "Self-hosted" below). It is, however, the only option among the five whose vendor
docs use the words "untrusted ... agent code" verbatim to describe the product's intended
threat model.

**Secrets/env injection.** `modal.Secret.from_dict({"MY_SECRET": "hello"})` passed via the
`secrets=[...]` parameter to `Sandbox.create(...)` injects values as environment variables at
sandbox start. ([Modal docs: Sandboxes](https://modal.com/docs/guide/sandbox)) Simple,
per-call, no separate provisioning step required for ad hoc secrets.

---

## 4. E2B

**Cost.** Billed per second of running sandbox time, no stated minimum. Default 2-vCPU
sandbox: $0.000028/s CPU (1 vCPU = $0.000014/s, scaling linearly to 8 vCPU = $0.000112/s), plus
$0.0000045/GiB-second memory. ([E2B Pricing](https://e2b.dev/pricing)) A 5-minute default
(2 vCPU) sandbox with 2 GiB memory ≈ 300s × ($0.000028 + 2×$0.0000045) ≈ **$0.0111**. Hobby tier
includes a one-time $100 usage credit, no card required; Pro is $150/month plus usage.

**Ops burden.** Fully managed, no infra to provision: API key + SDK call
(`Sandbox.create()`) is the entire setup, per the quickstart.
([E2B docs: Quickstart](https://docs.e2b.dev/quickstart)) Custom environments are built from a
Dockerfile (`e2b.Dockerfile` or specified via `-d/--dockerfile`) with `e2b build`, producing a
template ID used by the SDK to start sandboxes from that image (Debian-based images only).
([E2B docs: Custom sandbox](https://e2b.dev/docs/legacy/guide/custom-sandbox)) Run output is
retrieved directly from the SDK's execution object (`execution.logs`) rather than a separate
logs API. Lowest ops burden alongside Modal for this workload shape.

**Isolation.** E2B sandboxes are built on a forked Firecracker microVM runtime: "creating,
controlling, and tearing down isolated Firecracker microVMs on demand," cold-starting in
under ~200ms and running up to 24 hours (Pro tier; 1 hour default/Hobby).
([E2B GitHub project description](https://github.com/api-evangelist/e2b-dev); lifecycle limits
confirmed in [E2B docs: Sandbox](https://docs.e2b.dev/sandbox)) Firecracker provides
"hardware-level isolation via KVM-based virtualization, ensuring each sandbox operates with its
own kernel," i.e., the same VM-level isolation tier as Fargate/Fly Machines, plus E2B layers the
Firecracker "jailer" for defense-in-depth. E2B's product positioning is explicitly built for "AI
agents and AI-generated code," i.e., a documented threat model matching semi-trusted
agent-driven execution.

**Secrets/env injection.** `Sandbox.create({ envs: { MY_VAR: 'my_value' } })` (JS) /
`Sandbox.create(envs={'MY_VAR': 'my_value'})` (Python) sets global env vars at sandbox creation
time, available for the sandbox's lifetime; E2B also auto-injects `E2B_SANDBOX`,
`E2B_SANDBOX_ID`, `E2B_TEMPLATE_ID` metadata vars.
([E2B docs: Environment variables](https://docs.e2b.dev/sandbox/environment-variables)) Same
simple per-call pattern as Modal.

---

## 5. Self-hosted Docker + Firecracker/gVisor

**Cost.** No vendor meter — cost is whatever compute you provision plus your own ops time.
Firecracker requires KVM access (Linux kernel ≥4.14, hardware virtualization support), which in
practice means bare-metal or nested-virtualization-enabled instances rather than arbitrary
shared VMs. ([Firecracker microVM docs](https://firecracker-microvm.github.io/)) gVisor
(`runsc`) does not require KVM/bare metal — it runs as an OCI-compatible container runtime on
ordinary Linux hosts, integrating with Docker/Kubernetes directly. ([gVisor docs](https://gvisor.dev/docs/))
Either way, unless you also build your own scale-to-zero/autoscaling control plane, the host(s)
you run this on are billed continuously (idle cost) between agent sessions — the opposite of
the other four options' true pay-per-execution model. Building that autoscaling layer well is
itself a large share of what Fargate/Fly/Modal/E2B already sell as a managed product.

**Ops burden.** Highest of the five, by a wide margin. You own: host provisioning and patching,
installing/configuring the Firecracker VMM or `runsc` runtime and (for Firecracker) the
`jailer` companion process for defense-in-depth, a run/stop/teardown control plane (Firecracker
exposes only a low-level per-VM RESTful config API, not a fleet-management API), log capture
and shipping, and networking/security-group equivalents. None of this is available "out of the
box" — it's the same primitives AWS/Fly/Modal/E2B already built and are reselling as a managed
API.

**Isolation.** This is the only option where you choose (and are responsible for correctly
configuring) the isolation technology yourself. Firecracker's microVM/KVM model matches
Fargate's and Fly's underlying isolation tier if configured correctly, including the `jailer`
hardening layer. ([Firecracker docs](https://firecracker-microvm.github.io/)) gVisor's
Sentry/Gofer/`runsc` model matches Modal's underlying isolation tier.
([gVisor docs](https://gvisor.dev/docs/)) Neither vendor's own docs make a claim about your
specific deployment being secure by default — that assurance (network defaults, jailer usage,
kernel patching cadence, etc.) is entirely on whoever operates it, unlike the managed options
where the vendor documents and stands behind a specific configuration.

**Secrets/env injection.** No vendor-provided mechanism at all — this is something you build:
e.g., writing env vars into the Firecracker VM's boot config or a gVisor/`runsc` container spec
at launch time, plus your own secret-fetching logic (pulling from whatever secret store you
choose) before each run. Fully flexible, but 100% custom-built rather than a documented API
call.

---

## Comparison at a glance

| | Cost model (steady-state) | Idle cost | Ops burden for "run → logs → teardown" | Isolation | Env/secret injection |
|---|---|---|---|---|---|
| **AWS Fargate/ECS** | Per-second, ~$0.004/5min (1vCPU/2GB) | None while stopped | Moderate: task def, IAM roles, VPC/subnets, log group | VM-level (Firecracker), general-purpose | `environment` + `secrets` (Secrets Manager/SSM ARNs) in task def/overrides |
| **Fly Machines** | Per-second, ~$0.004/5min | Storage-only when stopped | Low: one CLI/API call to run, one to stop/destroy | VM-level (Firecracker) | `--env` flags + Base64 `fly secrets` |
| **Modal** | Per-second, ~$0.016/5min (sandbox tier) | None ("never pay for idle") | Lowest: `pip install` + API token, no cluster/VPC | gVisor sandbox, explicitly for "untrusted...agent code" | `modal.Secret` dict at `Sandbox.create()` |
| **E2B** | Per-second, ~$0.011/5min (2vCPU default) | None | Lowest: API key + SDK call, Dockerfile-based templates | Firecracker microVM, explicitly for "AI agents and AI-generated code" | `envs` dict at `Sandbox.create()` |
| **Self-hosted Firecracker/gVisor** | Raw compute only | Yes, unless you build autoscaling | Highest: you build the entire control plane | Same underlying tech as managed options, but you own correctness | Fully custom, no vendor API |

---

## Recommendation

**Shortlist: E2B and Modal**, both purpose-built for exactly this workload shape — ephemeral,
sandboxed, per-second-billed execution of semi-trusted/agent-driven code, with per-call
secret/env injection and no cluster/VPC to operate. Either would satisfy all four criteria well
above the bar set by Fargate (heavier IaC for no isolation benefit) or self-hosting (all the
ops burden of the underlying tech, none of the managed convenience, plus idle-host cost risk).
Fly Machines is a reasonable fallback if the team wants a more general "run any VM" primitive
outside the AI-sandbox product category, but its docs don't make the same explicit "designed
for agent/untrusted code" claim that E2B and Modal do.

**Primary pick: E2B.** Rationale tied to the four criteria:

1. **Cost** — true per-second billing with no idle charge, in the same order of magnitude as
   every other managed option (~$0.01 for a 5-minute default-size run); a one-time $100 credit
   covers substantial early usage with no card required.
2. **Ops burden** — lowest of the five: an API key and an SDK call is the entire setup, and a
   custom agent environment (Claude Code CLI, git, language toolchains, this repo's deps) is
   just a Dockerfile built with `e2b build`. No cluster, VPC, IAM roles, or log pipeline to
   stand up.
3. **Isolation** — Firecracker microVMs (the same hardware-virtualization boundary AWS uses for
   Fargate/Lambda), with the `jailer` layered on top, and vendor documentation that explicitly
   frames the product as running "AI agents and AI-generated code" — the closest documented
   match to this ticket's "agent-driven code" threat model of the five options.
4. **Secrets/env injection** — a single `envs` dict passed to `Sandbox.create()` at start time,
   exactly the "inject at container-start, not baked into a long-lived deployment" shape this
   spec needs.

Modal is a genuinely close second and arguably the safer choice if the team anticipates ever
needing GPU-backed runs or prefers Python-native infra-as-code (`modal.App`) over a Dockerfile
CLI build step — its gVisor isolation and "untrusted...agent code" framing are equally strong
on the isolation/positioning axis, and its per-second cost is comparable. The deciding factors
favoring E2B for this spec are the VM-level (vs. syscall-level) isolation boundary and the
Dockerfile-based template workflow being a closer match to "package this repo's existing
container image and run it," rather than adopting Modal's own Image-build abstraction.
