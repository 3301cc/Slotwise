-- Google-Push-Notifications: Replay-Schutz über X-Goog-Message-Number (core/src/googleWebhook.ts)
-- client_state       = X-Goog-Channel-Token (Geheimnis je Channel, 32 Zufallsbytes base64url)
-- provider_resource_id = X-Goog-Resource-ID (muss bei jeder Notification übereinstimmen)
ALTER TABLE webhook_channels ADD COLUMN IF NOT EXISTS last_message_number bigint;

-- Ein Google-Channel ohne Token oder Resource-ID wäre nicht prüfbar → gar nicht erst speicherbar
ALTER TABLE webhook_channels DROP CONSTRAINT IF EXISTS webhook_channels_google_verifiable;
ALTER TABLE webhook_channels ADD CONSTRAINT webhook_channels_google_verifiable
  CHECK (provider <> 'google' OR (client_state IS NOT NULL AND length(client_state) >= 16 AND provider_resource_id IS NOT NULL))
  NOT VALID;
