// Inngest function registry endpoint. Inngest's runtime calls this URL to
// discover functions (registration) and to invoke them when events match.
//
// Local: `npx inngest-cli dev` polls this at http://localhost:3000/api/inngest.
// Prod: Inngest cloud calls https://harkness-helper-v2-sgs.vercel.app/api/inngest.

import { serve } from "inngest/next";
import { inngest } from "@/lib/inngest/client";
import { transcribeDiscussion } from "@/lib/inngest/transcribe-discussion";

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [transcribeDiscussion],
});
