import { describe, it, expect } from "vitest";
import { metaDetailSchema } from "@p2p-songs/addon-sdk";
import { metaFor } from "../src/meta.js";
import { FakeMusicBrainz, UUID } from "./fakes.js";
import type { MbReleaseDetail } from "@p2p-songs/musicbrainz";

const releaseDetail: MbReleaseDetail = {
  id: UUID.release,
  title: "Deluxe Edition",
  artist: "Some Artist",
  date: "1997-05-12",
  tracks: [
    { trackId: UUID.trackD1, recordingId: UUID.rec1, title: "Opening", disc: 1, position: "1", durationMs: 262000 },
    // Bonus disc: same recording reappears, distinct track id + free-text position.
    { trackId: UUID.trackD2, recordingId: UUID.rec1, title: "Opening (reprise)", disc: 2, position: "A4" },
  ],
};

describe("metaFor keys off the id entity and builds honest detail", () => {
  it("release id → album detail with recording/track split preserved", async () => {
    const mb = new FakeMusicBrainz({ releaseDetail: { [UUID.release]: releaseDetail } });
    const meta = await metaFor(`mbid:release:${UUID.release}`, { mb });
    expect(meta).toBeDefined();
    expect(metaDetailSchema.safeParse(meta).success).toBe(true);
    expect(meta!.type).toBe("album");

    const tracks = (meta as { tracks: { recordingId: string; trackId: string; disc: number; position: string }[] }).tracks;
    expect(tracks).toHaveLength(2);
    // Same recording, distinct track ids, disc + free-text position carried through.
    expect(tracks[0]!.recordingId).toBe(`mbid:recording:${UUID.rec1}`);
    expect(tracks[1]!.recordingId).toBe(`mbid:recording:${UUID.rec1}`);
    expect(tracks[0]!.trackId).not.toBe(tracks[1]!.trackId);
    expect(tracks[1]!.disc).toBe(2);
    expect(tracks[1]!.position).toBe("A4");
  });

  it("recording id → track detail", async () => {
    const mb = new FakeMusicBrainz({ recording: { [UUID.rec1]: { id: UUID.rec1, title: "Xtal", artist: "Aphex Twin", durationMs: 293000 } } });
    const meta = await metaFor(`mbid:recording:${UUID.rec1}`, { mb });
    expect(meta!.type).toBe("track");
    expect(meta!.id).toBe(`mbid:recording:${UUID.rec1}`);
    expect(metaDetailSchema.safeParse(meta).success).toBe(true);
  });

  it("artist id → artist detail", async () => {
    const mb = new FakeMusicBrainz({ artist: { [UUID.artist]: { id: UUID.artist, name: "Aphex Twin" } } });
    const meta = await metaFor(`mbid:artist:${UUID.artist}`, { mb });
    expect(meta!.type).toBe("artist");
    expect(metaDetailSchema.safeParse(meta).success).toBe(true);
  });

  it("a bare track id is not addressable on its own", async () => {
    const meta = await metaFor(`mbid:track:${UUID.trackD1}`, { mb: new FakeMusicBrainz() });
    expect(meta).toBeUndefined();
  });

  it("unknown entity → undefined", async () => {
    const meta = await metaFor(`mbid:release:${UUID.release}`, { mb: new FakeMusicBrainz() });
    expect(meta).toBeUndefined();
  });
});
