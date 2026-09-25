-- Shared media foundation: additive only.
--
-- This does not alter, read, copy, backfill, or delete rows from the legacy
-- WhatsApp `media` table. The separately invoked migration runner owns the
-- transaction, preflight, lock, and postcheck. Do not run this automatically
-- at application startup or as part of deployment.

CREATE TABLE media_assets (
  asset_id UUID PRIMARY KEY,
  source_channel TEXT NOT NULL
    CONSTRAINT media_assets_source_channel_not_blank CHECK (btrim(source_channel) <> ''),
  source_reference TEXT,
  media_type TEXT NOT NULL
    CONSTRAINT media_assets_media_type_check
      CHECK (media_type IN ('image', 'video', 'sticker', 'audio', 'document', 'file')),
  mime_type TEXT,
  storage_key TEXT,
  thumbnail_storage_key TEXT,
  byte_size BIGINT
    CONSTRAINT media_assets_byte_size_nonnegative CHECK (byte_size IS NULL OR byte_size >= 0),
  width INTEGER
    CONSTRAINT media_assets_width_positive CHECK (width IS NULL OR width > 0),
  height INTEGER
    CONSTRAINT media_assets_height_positive CHECK (height IS NULL OR height > 0),
  duration_ms BIGINT
    CONSTRAINT media_assets_duration_nonnegative CHECK (duration_ms IS NULL OR duration_ms >= 0),
  availability TEXT NOT NULL DEFAULT 'AVAILABLE'
    CONSTRAINT media_assets_availability_check CHECK (availability IN ('AVAILABLE', 'UNAVAILABLE')),
  unavailable_reason TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT media_assets_storage_contract_check CHECK (
    (availability = 'AVAILABLE' AND storage_key IS NOT NULL)
    OR (
      availability = 'UNAVAILABLE'
      AND storage_key IS NULL
      AND thumbnail_storage_key IS NULL
      AND unavailable_reason IS NOT NULL
    )
  )
);

CREATE UNIQUE INDEX media_assets_storage_key_unique
  ON media_assets(storage_key)
  WHERE storage_key IS NOT NULL;

CREATE UNIQUE INDEX media_assets_thumbnail_storage_key_unique
  ON media_assets(thumbnail_storage_key)
  WHERE thumbnail_storage_key IS NOT NULL;

CREATE TABLE media_asset_links (
  link_id UUID PRIMARY KEY,
  asset_id UUID NOT NULL
    REFERENCES media_assets(asset_id) ON DELETE RESTRICT,
  owner_channel TEXT NOT NULL
    CONSTRAINT media_asset_links_owner_channel_not_blank CHECK (btrim(owner_channel) <> ''),
  owner_type TEXT NOT NULL
    CONSTRAINT media_asset_links_owner_type_not_blank CHECK (btrim(owner_type) <> ''),
  owner_reference TEXT NOT NULL
    CONSTRAINT media_asset_links_owner_reference_not_blank CHECK (btrim(owner_reference) <> ''),
  relationship_type TEXT NOT NULL DEFAULT 'attachment'
    CONSTRAINT media_asset_links_relationship_type_not_blank CHECK (btrim(relationship_type) <> ''),
  ordinal INTEGER
    CONSTRAINT media_asset_links_ordinal_nonnegative CHECK (ordinal IS NULL OR ordinal >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX media_asset_links_owner_lookup_idx
  ON media_asset_links(owner_channel, owner_type, owner_reference, created_at DESC);

CREATE INDEX media_asset_links_asset_idx
  ON media_asset_links(asset_id);
