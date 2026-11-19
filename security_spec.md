# ChiffrageDZ Firestore Security Specification (Phase 0 TDD)

## 1. Data Invariants
1. Every `Tender`, `TenderLot`, `LineItem`, `Anomaly`, and `PrivateBpuEntry` belongs strictly to a single authenticated `ownerId` matching `request.auth.uid` with verified email (`request.auth.token.email_verified == true`).
2. Every subcollection document under `/tenders/{tenderId}` (`lots`, `line_items`, `anomalies`) MUST verify via parent `get()` that `/tenders/{tenderId}` exists and `parent.ownerId == request.auth.uid`.
3. `rfq_public/{shareToken}` exposes ONLY sanitized supplier-facing fields (trade, delivery wilaya, deadline, bounded `items` list <= 30) via `get` by unguessable `shareToken`. `allow list` is strictly `false` for public callers (only owner can list their own batches where `resource.data.ownerId == request.auth.uid`).
4. `rfq_public/{shareToken}/quotes/{quoteId}` allows unauthenticated `create` ONLY if the parent `rfq_public/{shareToken}` exists with `status == 'open'`, `incoming().ownerId == parent.ownerId`, `incoming().selected == false`, and bounded `lineQuotes` array (`<= 30`). Suppliers can NEVER `get`, `list`, `update`, or `delete` quotes, guaranteeing total competitor confidentiality.
5. All `createdAt` and `updatedAt` timestamps must match `request.time`. All IDs must match `^[a-zA-Z0-9_\-]+$` with max length 128. All strings must enforce explicit `.size()` caps.

## 2. The "Dirty Dozen" Adversarial Payloads (Must Return PERMISSION_DENIED)
1. **Identity Spoofing on Tender Create**: Authenticated user A submits `ownerId: "user_B"` on `/tenders/t1`.
2. **Shadow Field Injection on Tender Create**: Authenticated user A adds ghost field `isAdmin: true` to `/tenders/t1`.
3. **Timestamp Forgery**: User submits `createdAt` set to a client-chosen past date instead of `request.time`.
4. **Path ID Poisoning**: Attacker writes to `/tenders/` with a 1.5KB junk document ID containing invalid characters.
5. **Orphan Subcollection Write**: User creates `/tenders/nonexistent/line_items/item1`.
6. **Cross-Tenant Subcollection Read**: User B attempts `get` on `/tenders/t1/line_items/item1` owned by User A.
7. **Unbounded Array Exhaustion**: Supplier submits `lineQuotes` with 50 elements (`> 30`) on `/rfq_public/tok1/quotes/q1`.
8. **Competitor Quote Scraping**: Unauthenticated supplier attempts `list` or `get` on `/rfq_public/tok1/quotes`.
9. **Public RFQ Enumeration**: Unauthenticated actor attempts `list` on `/rfq_public`.
10. **Pre-Selected Winning Quote Attack**: Supplier submits `selected: true` when creating a quote on `/rfq_public/tok1/quotes/q2`.
11. **Closed Batch Quote Injection**: Supplier submits a quote when parent `rfq_public/tok1` has `status == 'closed'`.
12. **Terminal State Mutation**: Owner attempts to mutate a tender whose status is already `'submitted'` (terminal lock) or attempts to alter immutable `ownerId` / `createdAt`.
