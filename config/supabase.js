const { createClient } = require("@supabase/supabase-js");

// Regular client (uses anon key — for RLS-protected operations)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Admin client (uses service role key — bypasses RLS, used only in backend)
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Ensure 'hall-assets' storage bucket exists in Supabase
async function ensureStorageBucket() {
  try {
    const { data: buckets, error: getError } = await supabaseAdmin.storage.listBuckets();
    if (getError) {
      console.error("Error listing Supabase buckets:", getError.message);
      return;
    }
    const exists = buckets.some(b => b.id === 'hall-assets');
    if (!exists) {
      const { error: createError } = await supabaseAdmin.storage.createBucket('hall-assets', {
        public: true,
        allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
        fileSizeLimit: 5 * 1024 * 1024 // 5MB
      });
      if (createError) {
        console.error("Error creating 'hall-assets' bucket in Supabase:", createError.message);
      } else {
        console.log("Successfully created 'hall-assets' public storage bucket in Supabase.");
      }
    }
  } catch (err) {
    console.error("Failed to verify/create 'hall-assets' storage bucket:", err.message);
  }
}

ensureStorageBucket();

module.exports = { supabase, supabaseAdmin };