import type {
  MusicBrainzClient,
  MbArtist,
  MbRelease,
  MbAlbum,
  MbRecording,
  MbReleaseDetail,
} from "@p2p-songs/musicbrainz";

/** A configurable in-memory MusicBrainz client for tests. */
export class FakeMusicBrainz implements MusicBrainzClient {
  constructor(
    private data: {
      artists?: MbArtist[];
      releases?: MbRelease[];
      recordings?: MbRecording[];
      releaseDetail?: Record<string, MbReleaseDetail>;
      artist?: Record<string, MbArtist>;
      recording?: Record<string, MbRecording>;
      discography?: MbAlbum[];
    } = {},
  ) {}

  async searchArtists(): Promise<MbArtist[]> {
    return this.data.artists ?? [];
  }
  async searchReleases(): Promise<MbRelease[]> {
    return this.data.releases ?? [];
  }
  async searchRecordings(): Promise<MbRecording[]> {
    return this.data.recordings ?? [];
  }
  async artistDiscography(): Promise<MbAlbum[]> {
    return this.data.discography ?? [];
  }
  async getArtist(uuid: string): Promise<MbArtist | undefined> {
    return this.data.artist?.[uuid];
  }
  async getRelease(uuid: string): Promise<MbReleaseDetail | undefined> {
    return this.data.releaseDetail?.[uuid];
  }
  async getAlbum(uuid: string): Promise<MbReleaseDetail | undefined> {
    return this.data.releaseDetail?.[uuid];
  }
  async getRecording(uuid: string): Promise<MbRecording | undefined> {
    return this.data.recording?.[uuid];
  }
}

export const UUID = {
  artist: "cccccccc-cccc-cccc-cccc-cccccccccccc",
  release: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
  rec1: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  rec2: "dddddddd-dddd-dddd-dddd-dddddddddddd",
  trackD1: "11111111-1111-1111-1111-111111111111",
  trackD2: "22222222-2222-2222-2222-222222222222",
};
