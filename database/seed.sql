-- LIT Portal — initial seed data
-- Content extracted from designs/mobile/lit-the-world-hifi/index.html (Diane's hi-fi).
-- Real photography swap pending; for now placeholder image URLs.
--
-- Run after schema.sql: npm run seed
-- (or paste in Supabase SQL Editor)

-- ============================================================
-- The World — events (Madrid)
-- ============================================================

insert into events (city, title_en, title_es, description_en, description_es, datetime, hero_image, ticket_url, capacity, status)
values
  ('madrid', 'Rooftop Launch', 'Lanzamiento Azotea',
   'Azotea Círculo de Bellas Artes · 250 capacity', 'Azotea Círculo de Bellas Artes · 250 plazas',
   '2026-05-24T20:00:00+02:00',
   null, null, 250, 'active'),

  ('madrid', 'Night Run', 'Carrera Nocturna',
   'Mon 20:30 · Retiro · 6 km pace group', 'Lun 20:30 · Retiro · Grupo de 6 km',
   '2026-05-26T20:30:00+02:00',
   null, null, null, 'active'),

  ('madrid', 'Open Mat', 'Open Mat',
   'Sat 10:00 · BJJ Madrid · Members only', 'Sáb 10:00 · BJJ Madrid · Miembros',
   '2026-05-31T10:00:00+02:00',
   null, null, null, 'active'),

  ('madrid', 'Sunset Ride', 'Ruta del Atardecer',
   'Sun 19:00 · Casa de Campo · 30 km group', 'Dom 19:00 · Casa de Campo · 30 km grupo',
   '2026-06-01T19:00:00+02:00',
   null, null, null, 'active'),

  ('madrid', 'LIT × Barry''s', 'LIT × Barry''s',
   'Sun 09:00 · Chueca · Red room + stack', 'Dom 09:00 · Chueca · Sala roja + recuperación',
   '2026-06-08T09:00:00+02:00',
   null, null, null, 'active');

-- ============================================================
-- The World — stories (editorial)
-- ============================================================

insert into stories (type, slug, title_en, title_es, body_en, body_es, cover_image, published_at)
values
  ('feature', 'inside-madrid-night-run-scene',
   'Inside Madrid''s night run scene', 'Dentro de las carreras nocturnas de Madrid',
   'The 20:30 pack at Retiro started at six. Now it''s 200. From a small Wednesday meet to a city-wide ritual — how a tempo run became Madrid''s most consistent post-work tradition.',
   'El grupo de las 20:30 en Retiro empezó con seis. Ahora son 200. De un encuentro pequeño los miércoles a un ritual urbano — cómo una carrera a ritmo se convirtió en la tradición post-trabajo más constante de Madrid.',
   null, now() - interval '7 days'),

  ('letter', 'what-200-members-taught-us',
   'What 200 members taught us', 'Lo que 200 miembros nos enseñaron',
   'Patterns from the first 200 LIT members. What they drink before training. What they ask us. What they''d change.',
   'Patrones de los primeros 200 miembros de LIT. Qué beben antes de entrenar. Qué nos preguntan. Qué cambiarían.',
   null, now() - interval '14 days'),

  ('recap', 'rooftop-launch-recap',
   'Rooftop launch — recap', 'Recap del lanzamiento en la azotea',
   'May 24th. 250 people, one rooftop, salt in the air. Behind the scenes of the launch event.',
   '24 de mayo. 250 personas, una azotea, sal en el aire. Tras las cámaras del evento de lanzamiento.',
   null, now() - interval '21 days');

-- ============================================================
-- The World — moments (curated photos)
-- ============================================================
-- Placeholder image URLs — swap to real CDN URLs when photography is ready.

insert into moments (image_url, caption_en, caption_es, position)
values
  ('https://placehold.co/600x800/0f0e1a/ebee62?text=MOMENT+01', 'Salt before the start line.', 'Sal antes de la línea de salida.', 0),
  ('https://placehold.co/600x900/0f0e1a/ebee62?text=MOMENT+02', 'Day 14, identity shift.', 'Día 14, cambio de identidad.', 1),
  ('https://placehold.co/600x700/0f0e1a/ebee62?text=MOMENT+03', 'The 20:30 pack at Retiro.', 'El grupo de las 20:30 en Retiro.', 2),
  ('https://placehold.co/600x800/0f0e1a/ebee62?text=MOMENT+04', 'Open mat, Saturday.', 'Open mat, sábado.', 3),
  ('https://placehold.co/600x900/0f0e1a/ebee62?text=MOMENT+05', 'Casa de Campo, sunset.', 'Casa de Campo, atardecer.', 4),
  ('https://placehold.co/600x700/0f0e1a/ebee62?text=MOMENT+06', 'Lemon salt sticks.', 'Sticks de sal de limón.', 5),
  ('https://placehold.co/600x800/0f0e1a/ebee62?text=MOMENT+07', 'Rooftop, 20:00.', 'Azotea, 20:00.', 6),
  ('https://placehold.co/600x900/0f0e1a/ebee62?text=MOMENT+08', 'After the long ride.', 'Después de la ruta larga.', 7),
  ('https://placehold.co/600x700/0f0e1a/ebee62?text=MOMENT+09', 'Stretch room, Barry''s.', 'Sala de estiramiento, Barry''s.', 8),
  ('https://placehold.co/600x800/0f0e1a/ebee62?text=MOMENT+10', 'Box delivered.', 'Caja entregada.', 9);
