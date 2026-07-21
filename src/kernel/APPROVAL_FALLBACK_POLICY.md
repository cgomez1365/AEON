# Approval Fallback Policy (W5)

> Ship Plan v2, Month 3 — "A stuck queue with no resolution path is a production incident."

## Provisioning
- The **admin role is created at the FIRST block install** (first build-pipeline submission), never assumed. The installing operator becomes admin (`db/aeon-roles.json`).
- Solo mode: operator = approver. Approval is **always an explicit click** — MEDIUM/HIGH builds never self-approve just because requester == approver.
- Team mode: Tier 2/3 (MEDIUM/HIGH) builds route to the instance admin.

## 48-hour fallback
1. Any approval item `pending` for more than **48h** (`AEON_APPROVAL_STALE_HOURS` to override) raises exactly one escalation alert (deduped per item).
2. The alert is addressed to the **backup contact** in `db/aeon-roles.json` and broadcast on the terminal/notification stream. Transport (email/webhook) subscribes to that stream — the kernel itself never sends mail.
3. If **no backup contact is configured**, the alert itself says so and instructs how to set one (`POST /api/build/roles/backup-contact`). The queue keeps nagging on every check until a contact exists or the item is decided.
4. Escalation **never auto-approves or auto-rejects**. Fallback = a human gets told; the decision stays human (B5 discipline).
5. The stale check runs hourly in the kernel and on every queue read (`GET /api/build/queue` and `POST /api/build/queue/check-stale`).

## OWNER DECISION — SIGNED 2026-07-02 (operator-ratified)
- **Backup contact:** set your own address. Solo-operator reality: alerts reach your own inbox; escalation value unlocks in team mode. Override: `AEON_BACKUP_CONTACT` env or `POST /api/build/roles/backup-contact`.
- **Decision date:** 2026-07-02. Carried from M3 close; signed at M5 close.
