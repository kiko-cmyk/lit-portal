DROP TABLE IF EXISTS content_access_log;
DROP TABLE IF EXISTS content_items;
DROP TABLE IF EXISTS referral_conversions;
DROP TABLE IF EXISTS referral_codes;
DROP TABLE IF EXISTS rewards_events;
DROP TABLE IF EXISTS rewards_balances;
DROP TABLE IF EXISTS rewards_tiers;
DROP TABLE IF EXISTS auth_tokens;

CREATE TABLE auth_tokens (
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

CREATE TABLE rewards_tiers (
  name text PRIMARY KEY,
  min_points integer NOT NULL,
  benefits_json jsonb DEFAULT '[]',
  created_at timestamptz DEFAULT now()
);

INSERT INTO rewards_tiers (name, min_points, benefits_json) VALUES ('bronze', 0, '["Acceso al portal"]');
INSERT INTO rewards_tiers (name, min_points, benefits_json) VALUES ('silver', 1000, '["Contenido premium"]');
INSERT INTO rewards_tiers (name, min_points, benefits_json) VALUES ('gold', 5000, '["Envio gratis"]');

CREATE TABLE rewards_balances (
  customer_email text PRIMARY KEY,
  total_points integer DEFAULT 0,
  current_tier text DEFAULT 'bronze' REFERENCES rewards_tiers(name),
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE rewards_events (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  customer_email text NOT NULL,
  event_type text NOT NULL,
  points integer NOT NULL,
  metadata jsonb DEFAULT '{}',
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_rewards_events_email ON rewards_events(customer_email);

CREATE TABLE referral_codes (
  code text PRIMARY KEY,
  customer_email text UNIQUE NOT NULL,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE referral_conversions (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  referrer_code text NOT NULL REFERENCES referral_codes(code),
  referred_email text NOT NULL,
  order_id text,
  status text DEFAULT 'pending',
  points_awarded integer DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_referral_conversions_code ON referral_conversions(referrer_code);

CREATE TABLE content_items (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  title text NOT NULL,
  description text,
  video_url text,
  thumbnail_url text,
  required_tier text DEFAULT 'bronze' REFERENCES rewards_tiers(name),
  required_status text DEFAULT 'any',
  published boolean DEFAULT true,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE content_access_log (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  customer_email text NOT NULL,
  content_id uuid NOT NULL REFERENCES content_items(id),
  accessed_at timestamptz DEFAULT now()
);

CREATE INDEX idx_content_access_email ON content_access_log(customer_email);
