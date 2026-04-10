-- =============================================
-- LIT Portal — Schema completo
-- Ejecutar en Supabase SQL Editor
-- =============================================

-- 1. Auth tokens (magic links + sessions)
CREATE TABLE IF NOT EXISTS auth_tokens (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  token text UNIQUE NOT NULL,
  email text NOT NULL,
  expires_at timestamptz NOT NULL,
  used boolean DEFAULT false,
  is_session boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_auth_tokens_token ON auth_tokens(token);
CREATE INDEX idx_auth_tokens_email ON auth_tokens(email);

-- Auto-cleanup de tokens expirados (ejecutar periódicamente)
-- DELETE FROM auth_tokens WHERE expires_at < now();

-- 2. Rewards tiers
CREATE TABLE IF NOT EXISTS rewards_tiers (
  name text PRIMARY KEY,
  min_points integer NOT NULL,
  benefits_json jsonb DEFAULT '[]'::jsonb,
  created_at timestamptz DEFAULT now()
);

-- Seed tiers por defecto
INSERT INTO rewards_tiers (name, min_points, benefits_json) VALUES
  ('bronze', 0, '["Acceso al portal de cliente", "Contenido básico exclusivo"]'::jsonb),
  ('silver', 1000, '["Todo lo de Bronze", "Contenido premium", "Descuento 5% en próxima compra"]'::jsonb),
  ('gold', 5000, '["Todo lo de Silver", "Acceso anticipado a lanzamientos", "Descuento 10%", "Envío gratis"]'::jsonb)
ON CONFLICT (name) DO NOTHING;

-- 3. Rewards balances
CREATE TABLE IF NOT EXISTS rewards_balances (
  customer_email text PRIMARY KEY,
  total_points integer DEFAULT 0,
  current_tier text DEFAULT 'bronze' REFERENCES rewards_tiers(name),
  updated_at timestamptz DEFAULT now()
);

-- 4. Rewards events (historial de puntos)
CREATE TABLE IF NOT EXISTS rewards_events (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  customer_email text NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('purchase', 'referral', 'review', 'challenge', 'redemption')),
  points integer NOT NULL,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_rewards_events_email ON rewards_events(customer_email);

-- 5. Referral codes
CREATE TABLE IF NOT EXISTS referral_codes (
  code text PRIMARY KEY,
  customer_email text UNIQUE NOT NULL,
  created_at timestamptz DEFAULT now()
);

-- 6. Referral conversions
CREATE TABLE IF NOT EXISTS referral_conversions (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  referrer_code text NOT NULL REFERENCES referral_codes(code),
  referred_email text NOT NULL,
  order_id text,
  status text DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed')),
  points_awarded integer DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_referral_conversions_code ON referral_conversions(referrer_code);

-- 7. Content items (contenido exclusivo)
CREATE TABLE IF NOT EXISTS content_items (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  title text NOT NULL,
  description text,
  video_url text,
  thumbnail_url text,
  required_tier text DEFAULT 'bronze' REFERENCES rewards_tiers(name),
  required_status text DEFAULT 'any' CHECK (required_status IN ('active_subscriber', 'any')),
  published boolean DEFAULT true,
  created_at timestamptz DEFAULT now()
);

-- 8. Content access log (analytics)
CREATE TABLE IF NOT EXISTS content_access_log (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  customer_email text NOT NULL,
  content_id uuid NOT NULL REFERENCES content_items(id),
  accessed_at timestamptz DEFAULT now()
);

CREATE INDEX idx_content_access_email ON content_access_log(customer_email);
