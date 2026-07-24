/**
 * PROTOTYPE catalog builder — produces a small curated golden NDJSON so we can
 * eyeball data quality before committing infra.
 *
 * It reuses the shared MusicBrainz client's *official-albums* traversal
 * (artistDiscography = `primarytype:album AND -secondarytype:*`, edition-aware
 * getAlbum) over a curated artist seed. No free-text search, so no parodies /
 * covers / bootlegs can leak in — every row is official by construction.
 *
 * PRODUCTION will swap the per-artist API traversal for the MusicBrainz
 * *canonical bulk dump* + ListenBrainz popularity (offline, no rate limits) and
 * emit the same document shape. This is the eyeball, not the pipeline.
 *
 *   cd packages/musicmeta && node scripts/build-sample.mjs
 */
import { MusicBrainzApi, CachedMusicBrainz } from "@p2p-songs/musicbrainz";
import { writeFileSync } from "node:fs";

const UA = "p2p-songs-musicmeta/0.1.0 (https://github.com/p2p-songs/addons)";
const mb = new CachedMusicBrainz(new MusicBrainzApi(UA));

// A curated, unambiguously-official popular seed. In production this comes from
// ListenBrainz popularity (CC0), not a hand list.
const SEED = [
  "Taylor Swift", "Drake", "The Weeknd", "Beyoncé", "Kendrick Lamar",
  "Billie Eilish", "Ariana Grande", "Ed Sheeran", "Adele", "Bruno Mars",
  "Coldplay", "Daft Punk",
];
const ALBUMS_PER_ARTIST = 6;

const sanitize = (id) => id.replace(/[^A-Za-z0-9_-]/g, "_");
const docs = [];
const add = (d) => docs.push(d);

for (const name of SEED) {
  const artists = await mb.searchArtists(name, 5);
  const artist = artists.find((a) => a.name.toLowerCase() === name.toLowerCase()) ?? artists[0];
  if (!artist) { console.error(`  ! no MB artist for "${name}"`); continue; }

  const artistId = `mbid:artist:${artist.id}`;
  add({ docId: sanitize(artistId), id: artistId, type: "artist", name: artist.name, searchtext: artist.name });

  const albums = await mb.artistDiscography(artist.id, ALBUMS_PER_ARTIST);
  console.error(`  ${artist.name}: ${albums.length} official album(s)`);

  for (const alb of albums.slice(0, ALBUMS_PER_ARTIST)) {
    const albumId = `mbid:release:${alb.id}`;
    add({
      docId: sanitize(albumId), id: albumId, type: "album",
      name: alb.title, description: alb.artist,
      searchtext: `${alb.artist} ${alb.title}`, ...(alb.date ? { date: alb.date } : {}),
    });

    const detail = await mb.getAlbum(alb.id);
    if (!detail) continue;
    for (const t of detail.tracks) {
      const recId = `mbid:recording:${t.recordingId}`;
      const trackArtist = t.artist ?? alb.artist;
      add({
        docId: sanitize(recId), id: recId, type: "track",
        name: t.title, description: trackArtist,
        searchtext: `${trackArtist} ${t.title}`,
        album: alb.title, disc: t.disc, position: t.position,
      });
    }
  }
}

// Dedupe by id — a recording can appear on several releases.
const byId = new Map();
for (const d of docs) if (!byId.has(d.docId)) byId.set(d.docId, d);
const unique = [...byId.values()];
writeFileSync("catalog-sample.ndjson", unique.map((d) => JSON.stringify(d)).join("\n") + "\n");

const counts = unique.reduce((m, d) => ((m[d.type] = (m[d.type] || 0) + 1), m), {});
console.error(`\n=== wrote catalog-sample.ndjson ===`);
console.error(counts);
