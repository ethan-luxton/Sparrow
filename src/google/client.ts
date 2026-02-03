import { google } from 'googleapis';
import { PixelTrailConfig, getSecret, saveConfig, setSecret } from '../config/config.js';
import { logger } from '../lib/logger.js';

export function buildOAuthClient(cfg: PixelTrailConfig) {
  const clientId = cfg.google?.clientId;
  if (!clientId) throw new Error('Google clientId missing. Run `pt google-auth`.');
  const clientSecret = getSecret(cfg, 'google.clientSecret');
  const redirectUri = cfg.google?.redirectUri ?? 'urn:ietf:wg:oauth:2.0:oob';
  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  const tokenEnc = cfg.google?.tokenEnc;
  if (tokenEnc) {
    try {
      const tokenJson = getSecret(cfg, 'google.token');
      const token = JSON.parse(tokenJson);
      oauth2Client.setCredentials(token);
      oauth2Client.on('tokens', (newTokens) => {
        if (newTokens.refresh_token || newTokens.access_token) {
          const merged = { ...token, ...newTokens };
          try {
            const cfg2 = setSecret({ ...cfg }, 'google.token', JSON.stringify(merged));
            saveConfig(cfg2);
            logger.info('Google token refreshed and saved.');
          } catch (err) {
            logger.error(`Failed to save refreshed token: ${(err as Error).message}`);
          }
        }
      });
    } catch (err) {
      logger.error(`Failed to load stored Google token: ${(err as Error).message}`);
    }
  }
  return oauth2Client;
}
