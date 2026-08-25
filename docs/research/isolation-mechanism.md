# Isolation mechanism for GitHub Actions hosted runners

Research for a design spec on running autonomous coding agents (Claude Code / Claude Agent SDK,
executing arbitrary shell commands) inside GitHub Actions jobs on GitHub-hosted runners. The
question this doc answers: what is the actual container/sandbox isolation mechanism for
GitHub-hosted runners, and what does GitHub itself guarantee about it — not "GitHub secures it,"
but the specific mechanism and its documented edges.

**Method:** primary sources only — docs.github.com, github.blog, GitHub's own source
repositories (`actions/runner-images`), and GitHub's own security research team
(securitylab.github.com). Every claim below is cited inline. Where GitHub does not make an
explicit statement and a conclusion is my own inference from adjacent statements, it is flagged
as such rather than presented as fact. Third-party analyses (Wiz, Orca, Cycode, blog posts on
Firecracker-based *self-hosted* runner tooling, etc.) were found during search but are
deliberately excluded from citation per the sourcing requirement — noted below only where their
existence explains why a claim can't be sourced to GitHub itself.

---

## 1. Is each job a fresh, dedicated VM (not shared across jobs/customers)?

**Yes, for standard multi-core runners and larger runners — with one documented exception at the
smallest/free tier.**

GitHub's own concept page states plainly: "With the exception of single-CPU runners, each
GitHub-hosted runner is a new virtual machine (VM) hosted by GitHub with the runner application
and other tools preinstalled."
([About GitHub-hosted runners](https://docs.github.com/en/actions/concepts/runners/github-hosted-runners))

**The exception:** the free `ubuntu-slim` single-CPU runner tier. GitHub's reference page states
these "are hosted in a container on a shared VM," and that "when the job begins, GitHub
automatically provisions a new container for that job, and when the job has finished, the
container is automatically decommissioned." The container itself "provides hypervisor level 2
isolation," but runs in **unprivileged mode**, so "some operations requiring elevated
privileges — such as mounting file systems, using Docker-in-Docker, or accessing low-level kernel
features — are not supported."
([GitHub-hosted runners reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners))
So even the shared-VM tier gets a fresh container per job, never a container reused across jobs —
GitHub just layers container isolation on top of a shared VM rather than giving that tier a
dedicated VM.

**Larger runners:** GitHub's reference doc confirms they also "run on virtual machines (VMs),"
with "a virtual hard disk (VHD)" installed "during the VM creation process."
([Larger runners reference](https://docs.github.com/en/actions/reference/runners/larger-runners))
**Gap/inference:** GitHub's larger-runner docs do not re-state the "new VM per job" sentence
verbatim the way the general GitHub-hosted-runners page does. Larger runners are documented as a
subtype of GitHub-hosted runners (with autoscaling pools, runner groups, static-IP pools shared
"by all jobs in that pool"), which is consistent with the same per-job-VM model — but this is an
inference from the surrounding autoscaling/pool language, not a sentence GitHub states outright
for larger runners specifically.

**Multi-tenancy across customers:** GitHub does not explicitly state, in any primary source
found, whether the underlying physical host hardware is ever shared concurrently by VMs belonging
to different customers. The closest statements are "new virtual machine... hosted by GitHub" and,
separately, "GitHub-hosted runners execute code within ephemeral and clean isolated virtual
machines, meaning there is no way to persistently compromise this environment"
([Security hardening for GitHub Actions](https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions)).
Both describe the VM boundary and its ephemerality, not host-level co-tenancy. Treat "is the
physical host ever shared across customers" as **unanswered by GitHub's own docs**, not
affirmed or denied.

---

## 2. What hypervisor/virtualization technology backs the VMs?

**GitHub states the cloud provider and the runner-agent lineage, but does not name the
hypervisor, and does not state that Firecracker backs GitHub Actions hosted runners.**

GitHub's own docs state: "GitHub hosts Linux and Windows runners on virtual machines in Microsoft
Azure" and "GitHub hosts macOS runners in Azure data centers." They further state "The
GitHub-hosted runner application is a fork of the Azure Pipelines Agent."
([About GitHub-hosted runners](https://docs.github.com/en/actions/concepts/runners/github-hosted-runners))
This confirms Azure VMs as the substrate for standard and larger Linux/Windows/macOS runners.

**No GitHub-authored source (docs.github.com or github.blog) was found stating that Firecracker
backs GitHub Actions hosted runners, standard or larger.** Search surfaced several third-party
projects (Fireactions, actuated.com, `firecracker-microvm/firecracker-containerd`) that use
Firecracker to build *self-hosted* GitHub Actions runner infrastructure on customer-owned
hardware — these are unrelated to GitHub's own hosted-runner backend and are excluded from
citation as non-primary/non-GitHub sources. Do not conflate "Firecracker is used by some
self-hosted-runner tooling" with "GitHub's hosted runners run on Firecracker" — no primary source
supports the latter.

**One concrete, GitHub-stated data point on virtualization technology exists, but only for the
single-CPU tier:** the `ubuntu-slim` container is described as providing "hypervisor level 2
isolation."
([GitHub-hosted runners reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners))
GitHub does not name the specific technology behind that phrase (no mention of gVisor, Kata
Containers, or similar in this doc), so it should be reported as GitHub's own wording, not
translated into a named product.

**Larger runners vs. standard runners:** the only documented technical difference is capacity
(CPU/RAM/disk), OS-image choice (custom images, VHD-based), and networking add-ons (static IPs,
Azure VNet injection — see §6), not a different virtualization/hypervisor technology. No GitHub
source states larger runners use a different hypervisor than standard runners.
([Larger runners reference](https://docs.github.com/en/actions/reference/runners/larger-runners);
[About GitHub-hosted runners](https://docs.github.com/en/actions/concepts/runners/github-hosted-runners))

---

## 3. Is there an additional in-VM sandbox layer, or is the VM boundary the whole guarantee?

**For standard dedicated-VM runners (2-core and up) and larger runners: the VM boundary is the
entire documented isolation guarantee. Inside it, the job has full root/administrator access —
no seccomp profile, gVisor, or nested container sandbox is documented by GitHub.**

GitHub states directly: "The Linux and macOS virtual machines both run using passwordless
`sudo`." And: "Windows virtual machines are configured to run as administrators with User Account
Control (UAC) disabled."
([GitHub-hosted runners reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners))
GitHub's security-hardening guidance, which is the closest thing to an explicit hardening/threat
model doc for Actions, discusses workflow-level risks (untrusted `pull_request_target` triggers,
script injection, third-party actions, secrets in logs, `ps x -w` argument visibility between
jobs on a shared *self-hosted* runner) but contains **no mention of seccomp, gVisor, AppArmor, or
any in-VM syscall-restriction layer for GitHub-hosted runners.**
([Security hardening for GitHub Actions](https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions))

**The one documented exception, again, is the free single-CPU (`ubuntu-slim`) tier**, which
layers an *unprivileged container* (with the "hypervisor level 2 isolation" wording noted in §2)
on top of a shared VM — and that container explicitly disallows privileged operations like
mounting filesystems, Docker-in-Docker, and "low-level kernel features."
([GitHub-hosted runners reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners))
This is a *more* restricted environment than the standard dedicated-VM tier, not a
defense-in-depth layer added on top of it — an agent workload that needs Docker-in-Docker or
kernel-level operations would need to avoid this tier specifically.

**Inference:** because passwordless sudo / UAC-disabled admin is the stated default for the
dedicated-VM tiers, and no additional sandboxing layer is documented for them, an autonomous
agent executing arbitrary shell commands on a standard or larger GitHub-hosted runner should be
assumed to have effectively full control of that VM's OS for the job's duration — the VM boundary
(not any in-VM syscall filter) is what stands between the agent and GitHub's underlying host
infrastructure.

---

## 4. What persists vs. does not persist between two separate job runs?

**Filesystem, network configuration, and injected credentials do not persist — that follows from
GitHub's "ephemeral and clean" framing plus the per-job token lifecycle GitHub documents
explicitly. The one thing that intentionally persists across runs is the `actions/cache` store,
which is an explicit opt-in mechanism, not incidental leftover state.**

**VM/filesystem state:** "GitHub-hosted runners execute code within ephemeral and clean isolated
virtual machines, meaning there is no way to persistently compromise this environment."
([Security hardening for GitHub Actions](https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions))
Combined with "each GitHub-hosted runner is a new virtual machine"
([About GitHub-hosted runners](https://docs.github.com/en/actions/concepts/runners/github-hosted-runners)),
this supports "nothing on disk survives from one job to the next" as GitHub's stated model.
**Network/DNS state specifically** is not called out by name in any GitHub doc found — treat
"DNS/network state resets between jobs" as a reasonable inference from the fresh-VM model, not a
sentence GitHub states verbatim.

**`GITHUB_TOKEN`:** GitHub states "At the start of each workflow job, GitHub automatically
creates a unique `GITHUB_TOKEN` secret to use in your workflow," and "The `GITHUB_TOKEN` expires
when the job finishes." Maximum lifetime is bounded by job execution limits: up to 6 hours for
GitHub-hosted runners (their job time cap), and the self-hosted-runner token is capped at 24 hours
even though self-hosted jobs can run up to 5 days.
([GITHUB_TOKEN](https://docs.github.com/en/actions/concepts/security/github_token))
GitHub's docs do not explicitly say "the token cannot be reused across jobs," but the
generate-fresh-per-job-start/expire-at-job-end lifecycle they do state leaves no window for reuse
across separate job runs.

**`actions/cache`:** explicitly a deliberate, opt-in persistence mechanism layered on top of the
otherwise-ephemeral VM, not a side effect of runner reuse. It requires an explicit
`actions/cache` step; scope rules are documented precisely: "Workflow runs can restore caches
created in either the current branch or the default branch (usually `main`)," pull-request runs
"can also restore caches created in the base branch," and "Workflow runs cannot restore caches
created for child branches or sibling branches." Unused cache entries are evicted after a period
of inactivity (documented as 7 days).
([Caching dependencies to speed up workflows](https://docs.github.com/en/actions/writing-workflows/choosing-what-your-workflow-does/caching-dependencies-to-speed-up-workflows))
This is the one mechanism where data legitimately survives from one job run to a later one on
GitHub-hosted runners — by design, scoped, and requiring an explicit workflow step, not because
the VM itself was reused.

---

## 5. Documented isolation guarantees/limitations, escape risk, multi-tenancy, and self-hosted contrast

**No GitHub-published isolation-escape CVE or incident writeup was found in this pass.** Search
surfaced third-party security-vendor writeups (Wiz, Orca, Cycode) discussing GitHub Actions
attack techniques, but per the sourcing requirement these are excluded from citation, and none of
them pointed to a GitHub-authored disclosure of a *runner VM/container escape* specifically (as
opposed to workflow-level misconfigurations like script injection or `pull_request_target`
misuse). **State this as an absence of evidence, not evidence of absence** — it means no primary
GitHub source describing such an escape was located, not that GitHub has stated none exist.

**GitHub's own Security Lab** (its official security research team, publishing on
securitylab.github.com) has written in detail about `actions/cache` **poisoning** as a real,
acknowledged attack pattern: "the seemingly innocuous `permissions: {}` configuration can
unexpectedly pave the way for cache poisoning attacks," where an attacker "involves injecting
malicious content into the cache, which can subsequently affect other workflows relying on the
poisoned cache entries," and critically, "Even if a workflow doesn't have write access to the
repository, it can still poison the cache."
([Keeping your GitHub Actions and workflows secure, Part 4](https://securitylab.github.com/resources/github-actions-new-patterns-and-mitigations/))
This is a documented risk in the *cache* mechanism (§4), not a runner VM/container isolation
escape — the Security Lab piece contains no statement about infrastructure-level VM/container
isolation limits.

**Multi-tenancy model:** as noted in §1, GitHub states each (non single-CPU) job gets "a new
virtual machine," and that GitHub-hosted runners run in "ephemeral and clean isolated virtual
machines." GitHub does not explicitly state, in any source found, whether a given physical host
is ever shared concurrently by VMs belonging to different customers/orgs — only that the *VM*
itself is fresh per job. Treat the "one VM, one job, one customer, for the VM's whole lifetime,
then destroyed" model as **GitHub's stated model for the VM layer**, with host-level co-tenancy
left unaddressed.

**Self-hosted runner contrast — explicit and strongly worded in GitHub's own docs:**
- "Self-hosted runners for GitHub do not have guarantees around running in ephemeral clean
  virtual machines, and can be persistently compromised by untrusted code in a workflow."
- "Self-hosted runners should almost never be used for public repositories on GitHub, because
  any user can open pull requests against the repository and compromise the environment."
- Even for private repos: "anyone who can fork the repository and open a pull request (generally
  those with read access to the repository) are able to compromise the self-hosted runner
  environment, including gaining access to secrets and the `GITHUB_TOKEN`."
- A concrete cross-job leakage risk on shared self-hosted runners: "Some jobs will use secrets as
  command-line arguments which can be seen by another job running on the same runner, such as
  `ps x -w`."
([Secure use reference](https://docs.github.com/en/actions/reference/security/secure-use);
also stated in
[Security hardening for GitHub Actions](https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions))
This is GitHub's own explicit trust-model split: GitHub-hosted runners carry the "ephemeral and
clean, no persistent compromise" guarantee; self-hosted runners explicitly do **not**, unless the
operator builds equivalent ephemerality themselves.

---

## 6. Network policy defaults and egress control options

**Outbound internet is allowed by default; a limited hosts-blocklist applies; IP ranges are
published but explicitly not meant for allowlisting; egress control is opt-in and only available
on some runner types.**

**Default:** "By default, GitHub-hosted runners have access to the public internet."
([Private networking with GitHub-hosted runners](https://docs.github.com/en/actions/concepts/runners/private-networking))
GitHub additionally states: "GitHub-hosted runners are provisioned with an `/etc/hosts` file that
blocks network access to various cryptocurrency mining pools and malicious sites."
([Security hardening for GitHub Actions](https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions))
No comprehensive default egress *filtering* (beyond that blocklist) is documented — outbound
traffic to arbitrary hosts is otherwise unrestricted by default.

**Published IP ranges:** GitHub publishes IP ranges via the meta API (`api.github.com/meta`),
including `actions`/`actions_macos` keys for hosted-runner egress ranges. GitHub is explicit that
"the list of GitHub IP addresses returned by the Meta API is not intended to be an exhaustive
list," that these are "dynamically assigned... from shared infrastructure," and states plainly:
"We do not recommend allowing by IP address, but if you use these IP ranges we strongly encourage
regular monitoring of our API."
([About GitHub's IP addresses](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/about-githubs-ip-addresses))

**Egress control options — larger runners only:**
- **Static IP address ranges:** available for Linux and Windows larger runners; "all jobs in that
  pool share the same static IP address range," with up to 10 pools per account. Explicitly
  **not** available for macOS larger runners.
  ([Larger runners reference](https://docs.github.com/en/actions/reference/runners/larger-runners))
- **Azure private networking (VNet injection):** organizations can connect GitHub-hosted runners
  into "your Azure virtual network and subnet of choice," with existing Azure NSG/firewall rules
  automatically applying. Available for Linux and Windows larger runners on GitHub Team or
  Enterprise Cloud plans; **not available for standard GitHub-hosted runners, and not available
  for macOS larger runners.**
  ([Private networking with GitHub-hosted runners](https://docs.github.com/en/actions/concepts/runners/private-networking);
  [Bringing enterprise-level security and even more power to GitHub-hosted runners](https://github.blog/news-insights/product-news/bringing-enterprise-level-security-and-even-more-power-to-github-hosted-runners/))

**Standard (non-larger) GitHub-hosted runners have no documented egress-control knob** beyond the
default hosts-blocklist and the (explicitly-not-for-allowlisting) published meta-API IP ranges —
static IPs and VNet injection require upgrading to larger runners.

---

## Answer to the ticket question

- **1. Fresh VM per job?** Yes for standard multi-core and larger runners — GitHub states "each
  GitHub-hosted runner is a new virtual machine." The one exception is the free single-CPU
  (`ubuntu-slim`) tier, which uses a fresh, unprivileged *container* per job on a shared VM
  instead of a dedicated VM. GitHub does not explicitly confirm the underlying physical host is
  never shared across customers — only that the VM/container is fresh per job.
  ([docs](https://docs.github.com/en/actions/concepts/runners/github-hosted-runners))

- **2. Hypervisor/virtualization tech?** GitHub states standard and larger Linux/Windows/macOS
  runners run as VMs on **Microsoft Azure** (runner agent is a fork of the Azure Pipelines
  Agent). GitHub does **not** name the hypervisor (no Hyper-V or Firecracker claim found in
  GitHub's own docs/blog for hosted Actions runners) — Firecracker references found in research
  belong to unrelated third-party *self-hosted*-runner tooling, not GitHub's hosted
  infrastructure. Larger runners differ from standard runners in capacity/networking add-ons, not
  in a documented different hypervisor.
  ([docs](https://docs.github.com/en/actions/concepts/runners/github-hosted-runners))

- **3. Additional in-VM sandbox?** No, for standard/larger runners the VM boundary is the entire
  guarantee — Linux/macOS run passwordless `sudo`, Windows runs as admin with UAC disabled, and
  no seccomp/gVisor/nested-sandbox layer is documented. An agent's arbitrary shell commands have
  effective root/admin control of that VM. The one exception (again, `ubuntu-slim`) adds an
  *unprivileged* container layer that restricts rather than loosens capabilities.
  ([docs](https://docs.github.com/en/actions/reference/runners/github-hosted-runners))

- **4. What persists across job runs?** Nothing on disk, in network config, or in credentials
  persists by default — GitHub calls hosted runners "ephemeral and clean," and `GITHUB_TOKEN` is
  generated fresh per job and expires at job end (max 6h). The one intentional exception is
  `actions/cache`, an explicit opt-in step scoped by branch with a 7-day inactivity eviction — a
  deliberate mechanism, not leftover VM state.
  ([hardening docs](https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions),
  [token docs](https://docs.github.com/en/actions/concepts/security/github_token),
  [cache docs](https://docs.github.com/en/actions/writing-workflows/choosing-what-your-workflow-does/caching-dependencies-to-speed-up-workflows))

- **5. Escape risk, multi-tenancy, self-hosted contrast?** No GitHub-published runner-escape CVE
  was found in this pass (absence of evidence, not proof of absence). GitHub's own Security Lab
  has documented `actions/cache` poisoning as a real risk, but that's a cache-mechanism issue, not
  a VM/container escape. GitHub does not explicitly state whether physical hosts are shared across
  customers, only that each VM is fresh per job. GitHub explicitly and strongly warns self-hosted
  runners carry **no** such ephemeral/clean guarantee, "should almost never be used for public
  repositories," and can leak secrets between jobs sharing the same self-hosted runner.
  ([secure-use docs](https://docs.github.com/en/actions/reference/security/secure-use))

- **6. Network egress defaults?** Outbound internet is allowed by default (minus a small
  cryptomining/malicious-site hosts-blocklist). GitHub publishes IP ranges via
  `api.github.com/meta` but explicitly says not to rely on them for allowlisting, since they're
  dynamically assigned from shared infrastructure. Real egress control (static IP pools, Azure
  VNet injection) is only available on **larger runners** (Linux/Windows, not macOS) — standard
  hosted runners have no documented egress-control option.
  ([private networking docs](https://docs.github.com/en/actions/concepts/runners/private-networking),
  [IP addresses docs](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/about-githubs-ip-addresses))
