/** Wire catalog + meta into an SDK addon interface. */
import { AddonBuilder, type AddonInterface } from "@p2p-songs/addon-sdk";
import { manifest } from "./manifest.js";
import { searchCatalog, artistAlbumsCatalog } from "./catalog.js";
import { metaFor } from "./meta.js";
import type { MusicBrainzClient } from "@p2p-songs/musicbrainz";

export interface MusicMetaDeps {
  mb: MusicBrainzClient;
  /** Max catalog results per search (default 25). */
  catalogLimit?: number;
}

export function createMusicMetaAddon(deps: MusicMetaDeps): AddonInterface {
  const catalogDeps = { mb: deps.mb, ...(deps.catalogLimit ? { limit: deps.catalogLimit } : {}) };
  return new AddonBuilder(manifest)
    .defineCatalogHandler(async ({ type, id, extra }) => {
      if (id === "byArtist") {
        const artistId = extra.artistId?.trim();
        if (!artistId) return { metas: [] };
        const metas = await artistAlbumsCatalog(artistId, catalogDeps);
        return { metas, cacheMaxAge: 3600 };
      }
      const search = extra.search?.trim();
      if (!search) return { metas: [] }; // search is required for every search catalog
      const metas = await searchCatalog(type, search, catalogDeps);
      return { metas, cacheMaxAge: 3600 };
    })
    .defineMetaHandler(async ({ id }) => {
      const meta = await metaFor(id, { mb: deps.mb });
      // No empty-meta shape exists in the protocol; a missing id is exceptional
      // (the client only asks for ids it already discovered) → surfaces as 500.
      if (!meta) throw new Error(`meta not found: ${id}`);
      return { meta, cacheMaxAge: 24 * 3600 };
    })
    .getInterface();
}
