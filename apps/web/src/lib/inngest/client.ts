// Inngest client for Harkness Helper. The `id` here is the Inngest app id —
// keep it stable, since events route to functions by this identity. Separate
// from other suite apps (super-grader, HH, AID, OE) so function namespaces
// stay clean across the account.
//
// Local dev: `npx inngest-cli dev` discovers /api/inngest at localhost:3000
// and works without env keys. Production: INNGEST_EVENT_KEY +
// INNGEST_SIGNING_KEY come from the Inngest dashboard.

import { Inngest } from "inngest";

export const inngest = new Inngest({ id: "harkness-helper" });
