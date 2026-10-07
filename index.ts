// Supabase Edge Function: analyze-product
// Receives a product photo from the admin page and returns { name, category, description }.
// The Gemini API key lives ONLY here (as a Supabase secret), never in the website.
import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Tried in order; if one fails or is out of quota the next is used.
const MODELS = ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-3.5-flash-lite"];

// Used only if the admin page does not send its own category list.
const DEFAULT_CATEGORIES = [
  { key: "casual", label: "Casual" }, { key: "official", label: "Official" },
  { key: "jeans", label: "Jeans" }, { key: "shirts", label: "Shirts" },
  { key: "tshirts", label: "T-Shirts" }, { key: "shorts", label: "Shorts" },
  { key: "trousers", label: "Trousers" }, { key: "sweatpants", label: "Sweatpants" },
  { key: "jackets", label: "Jackets" }, { key: "accessories", label: "Accessories" },
];

function buildPrompt(cats: { key: string; label: string }[]) {
  return `You are helping a men's clothing shop (KD Wisdom Enterprise, Kejetia Market, Ghana) list a product from one photo.
Return RAW JSON only, no markdown:
{"name":"...","category":"...","description":"..."}
Rules:
- name: short and specific, e.g. "Men's Black Slim Fit Jeans", "White Graphic T-Shirt", "Camouflage Cargo Shorts", "Navy Nylon Track Pants".
- category: choose exactly ONE key from this list (key = label): ${cats.map((c) => `${c.key} = ${c.label}`).join("; ")}.
  Pick the closest match. Casual means relaxed everyday wear; official means office/formal wear.
- description: 1-2 friendly sentences for customers about what is visible (colour, style, fit, details). Do NOT invent brands, fabric, sizes or prices you cannot see.`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

  try {
    // 1. Only a signed-in admin may use this (stops strangers spending your AI quota)
    const token = (req.headers.get("Authorization") || "").replace("Bearer ", "");
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!);
    const { data, error } = await sb.auth.getUser(token);
    if (error || !data?.user) return json({ error: "Please log in again." }, 401);

    const apiKey = Deno.env.get("GEMINI_API_KEY");
    if (!apiKey) return json({ error: "GEMINI_API_KEY secret is not set." }, 500);

    // 2. Read the photo and the shop's current category list
    const { image, mimeType, categories } = await req.json();
    if (!image || typeof image !== "string") return json({ error: "No image received." }, 400);
    if (image.length > 4_000_000) return json({ error: "Image too large." }, 413);

    const cleaned = Array.isArray(categories)
      ? categories
          .filter((c: any) => c && typeof c.key === "string" && typeof c.label === "string")
          .map((c: any) => ({ key: c.key.slice(0, 30), label: c.label.slice(0, 40) }))
          .slice(0, 40)
      : [];
    const cats = cleaned.length > 0 ? cleaned : DEFAULT_CATEGORIES;
    const keys = cats.map((c) => c.key);

    // 3. Ask Gemini (fallback through the model list)
    let lastErr = "";
    for (const model of MODELS) {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [
            { text: buildPrompt(cats) },
            { inline_data: { mime_type: mimeType || "image/jpeg", data: image } },
          ] }],
          generationConfig: { responseMimeType: "application/json", temperature: 0.4 },
        }),
      });

      if (!res.ok) { lastErr = `${model}: ${res.status}`; continue; }

      const out = await res.json();
      const text = out?.candidates?.[0]?.content?.parts?.[0]?.text || "";
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) { lastErr = `${model}: unreadable reply`; continue; }

      const parsed = JSON.parse(match[0]);
      const category = String(parsed.category || "").trim();
      return json({
        name: String(parsed.name || "").slice(0, 80),
        category: keys.includes(category) ? category : "",
        description: String(parsed.description || "").slice(0, 400),
        model,
      });
    }
    return json({ error: "AI is busy or out of quota right now (" + lastErr + ")." }, 502);
  } catch (e) {
    return json({ error: String((e as Error).message || e) }, 500);
  }
});
