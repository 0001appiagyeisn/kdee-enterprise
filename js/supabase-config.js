import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const SUPABASE_URL = 'https://bklonxflimbhmhtbtzqb.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJrbG9ueGZsaW1iaG1odGJ0enFiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA3NTgzMDMsImV4cCI6MjEwNjMzNDMwM30.8DTI8QU7SKPMtoGikM4YSz5ZQ4uzGdwy8Bgje1DaOs8';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
export const WHATSAPP_NUMBER = "233500111114";
export const BRAND_NAME = "KDee Enterprise";