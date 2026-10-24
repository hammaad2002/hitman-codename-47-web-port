// .ffs sound-bank decoder (Bella Sara ships fmod.dll 3.75 with two banks at Win32/Sound/*).
// Established from the shipped bytes; offsets/field sizes are documented in work/AUDIO-NOTES.md
// and inline comments. A bank is an "FFS " index of entries: each .FSB entry is a standard FMOD
// FSB3.1 sample bank (see parse_fsb) whose samples are PCM16LE (mono/stereo) or stereo IMA ADPCM
// (confirmed FMOD 3 layout: per-block per-channel headers, then byte-interleaved 4-byte code
// bands with low-nibble-first codes, 63 codes + the header amplitude per channel per 72-byte
// block). Decoding returns PCM for playback only (bank bytes are read through a FILE*, never
// resident). Pure std::C++ (no rt:: / platform deps) so runtime/tests/ffs_test.cpp can link
// bella_runtime without any host stubs.
#pragma once

#include <cstdint>
#include <map>
#include <memory>
#include <string>
#include <utility>
#include <vector>

namespace audio {

// One FMOD FSB3.1 sample header (see AUDIO-NOTES.md for offsets).
struct FfsSampleInfo {
  uint32_t index = 0;          // subsong index in the FSB
  std::string name;            // e.g. "AwardNormal_01.wav" (NUL-trimmed, up to 30 bytes)
  uint32_t num_samples = 0;    // frames
  uint32_t stream_size = 0;    // compressed bytes
  uint32_t loop_start = 0;     // in frames
  uint32_t loop_end = 0;       // in frames (this bank stores num_samples normally)
  uint32_t mode = 0;           // FSOUND_* mode bits (0x131 PCM16 mono, 0x151 PCM16 stereo,
                               //                  0x00400041 IMA ADPCM stereo in these banks)
  uint32_t sample_rate = 0;
  uint16_t def_vol = 0, def_pan = 0, def_pri = 0, channels = 0;
  float min_dist = 0, max_dist = 0;  // FSOUND 3.1 header extras
  uint16_t var_freq = 0, var_vol = 0, var_pan = 0;
  uint32_t data_rel = 0;  // byte offset of this sample's data from the FSB data region (plumbing)
  // Attached .DAT record (see AUDIO-NOTES.md): count == FSB subsong count; each sample gets
  // {u32 flag, f32 distance}. The game's EQ_SoundFFSData loads these; dist is modelled as the 3D
  // maximum hearing distance and flag as 2D-ish/non-3D (conservative; M5 confirm). When a bank
  // has fewer .DAT rows than subsongs, leftovers keep flag -2/no companion row.
  int32_t dat_flag = -2;  // -2 = no .DAT companion entry (or row) for this sample
  float dat_dist = 0;

  // Derivations for playback.
  int channels_out() const { return channels; }
  bool is_ima() const { return (mode & 0x00400000) != 0; }
};

// A whole .ffs bank held open against its host path; entries are addressed by name.
class FfsBank {
 public:
  struct Entry {
    std::string name;    // e.g. "UIHORSE.FSB" / "UIHORSE.DAT" (always upper case)
    uint32_t offset = 0;  // byte offset in the bank
    uint32_t size = 0;    // exact payload byte count (a 0xFF separator byte follows it)
  };

  // Parses the "FFS " directory + every .FSB's FSB3 header + the .DAT tables fully: cheap IO
  // (header-size reads, never the payloads). Returns nullptr and fills *error on problems.
  static std::unique_ptr<FfsBank> open(const std::string& host_path, std::string* error);

  const std::string& path() const { return path_; }

  // Case-insensitive entry lookup.
  bool entry(const std::string& name, Entry* out) const;
  const std::vector<Entry>& entries() const { return entries_; }
  bool is_fsb(const Entry& e) const { return e.name.size() >= 4 && e.name.compare(e.name.size() - 4, 4, ".FSB") == 0; }

  // Number of samples inside a .FSB entry, from the FSB3 header.
  uint32_t entry_subsongs(const Entry& e) const;

  // Sample metadata for one subsong (decoded from headers, includes its .DAT companion values).
  bool sample_info(const Entry& e, uint32_t subsong, FfsSampleInfo* out, std::string* error) const;

  // Full decode of one subsong to signed 16-bit interleaved PCM at the sample's own rate.
  bool decode_sample(const Entry& e, uint32_t subsong, std::vector<int16_t>* pcm,
                     FfsSampleInfo* out, std::string* error) const;

  // One decoded subsong of an in-memory FSB3 blob (the FMOD "bank bytes handed over out of
  // band" case: FSOUND_LOADMEMORY streams/modules, or a raw .fsb inside a foreign container).
  struct FfsSubsong {
    FfsSampleInfo info;
    std::vector<int16_t> pcm;  // signed 16-bit interleaved at the sample's own rate
  };

  // Parses the FSB3 blob (0x00 "FSB3" | count | headers | data) and decodes every subsong.
  // Returns false (with *error set) when the blob is not a parseable, self-consistent FSB3.
  static bool decode_fsb_bytes(const uint8_t* blob, size_t len, std::vector<FfsSubsong>* subs,
                               std::string* error);

 private:
  FfsBank() = default;
  std::string path_;
  std::vector<Entry> entries_;
  // ".FSB stem" -> per-subsong {flag, distance} rows parsed from the ".DAT" companions.
  std::map<std::string, std::vector<std::pair<int32_t, float>>> dat_rows_;
};

}  // namespace audio
