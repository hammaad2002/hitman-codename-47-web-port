// PE IMAGE_DIRECTORY_ENTRY_RESOURCE walker for BellaSara.exe (VFS host path).
#include "resources.h"

#include <cstring>
#include <fstream>
#include <map>
#include <mutex>
#include <unordered_map>
#include <vector>

#include "objects.h"
#include "rt.h"

namespace rt {
namespace {

constexpr uint32_t kPeResourceDirIndex = 2;  // IMAGE_DIRECTORY_ENTRY_RESOURCE
constexpr uint32_t kRtCursor = 1;
constexpr uint32_t kRtIcon = 3;
constexpr uint32_t kRtMenu = 4;
constexpr uint32_t kRtDialog = 5;
constexpr uint32_t kRtString = 6;
constexpr uint32_t kRtGroupCursor = 12;
constexpr uint32_t kRtGroupIcon = 14;
constexpr uint32_t kRtVersion = 16;

constexpr uint32_t kDlgSig = 0xffffu;
constexpr uint32_t kBsDefpushbutton = 0x00000001u;
constexpr uint32_t kWmInitdialog = 0x0110u;
constexpr uint32_t kWmCommand = 0x0111u;
constexpr uint32_t kIdok = 1;

struct Section {
  uint32_t va;
  uint32_t vsize;
  uint32_t raw_size;
  uint32_t raw_off;
};

struct PeImage {
  std::vector<uint8_t> bytes;
  uint32_t image_base = 0;
  uint32_t resource_rva = 0;
  uint32_t resource_size = 0;
  std::vector<Section> sections;
};

struct DataLeaf {
  uint32_t type_id = 0;
  uint32_t name_id = 0;
  uint32_t language_id = 0;
  size_t offset = 0;
  size_t size = 0;
};

struct DialogControl {
  uint32_t id = 0;
  uint32_t style = 0;
  std::string text;
};

struct DialogTemplate {
  uint32_t id = 0;
  std::string title;
  std::vector<DialogControl> controls;
  uint32_t default_button_id = kIdok;
};

static PeImage g_pe;
static std::unordered_map<uint32_t, std::string> g_strings;
static std::unordered_map<uint32_t, DataLeaf> g_icons;
static std::unordered_map<uint32_t, DataLeaf> g_group_icons;
static std::unordered_map<uint32_t, DataLeaf> g_cursors;
static std::unordered_map<uint32_t, DataLeaf> g_group_cursors;
static std::unordered_map<uint32_t, DataLeaf> g_menus;
static std::unordered_map<uint32_t, DataLeaf> g_dialogs;
static std::unordered_map<uint32_t, DataLeaf> g_versions;
static std::unordered_map<uint32_t, DialogTemplate> g_dialog_templates;
static size_t g_string_block_count = 0;
static bool g_open_ok = false;
static std::string g_open_error;
static std::once_flag g_open_once;

struct ActiveDialog {
  uint32_t hwnd = 0;
  uint32_t template_id = 0;
  std::map<uint32_t, std::string> control_text;
};
static ActiveDialog g_active_dialog;

static bool fail(std::string* err, const std::string& msg) {
  if (err) *err = msg;
  return false;
}

static uint16_t u16(const uint8_t* p) { return (uint16_t)(p[0] | (p[1] << 8)); }
static uint32_t u32(const uint8_t* p) { return (uint32_t)(p[0] | (p[1] << 8) | (p[2] << 16) | (p[3] << 24)); }

static bool bounds(const PeImage& pe, size_t off, size_t need) { return off + need <= pe.bytes.size(); }

static bool rva_to_offset(const PeImage& pe, uint32_t rva, size_t* out) {
  for (const Section& s : pe.sections) {
    uint32_t span = s.vsize ? s.vsize : s.raw_size;
    if (rva >= s.va && rva < s.va + span) {
      uint32_t delta = rva - s.va;
      if (delta > s.raw_size) return false;
      *out = s.raw_off + delta;
      return true;
    }
  }
  return false;
}

static bool offset_to_rva(const PeImage& pe, size_t off, uint32_t* out) {
  for (const Section& s : pe.sections) {
    if (off >= s.raw_off && off < s.raw_off + s.raw_size) {
      *out = s.va + (uint32_t)(off - s.raw_off);
      return true;
    }
  }
  return false;
}

static std::string wide_to_ansi(const uint16_t* w, size_t chars) {
  std::string s;
  s.reserve(chars);
  for (size_t i = 0; i < chars; i++) {
    uint16_t c = w[i];
    if (c <= 0xff) s += (char)c;
    else s += '?';
  }
  return s;
}

// Wide string (or 0xFFFF ordinal) reader at p (updates p).
static bool read_wstr(const uint8_t* data, size_t size, size_t& p, std::string& out) {
  if (p >= size) return false;
  if (data[p] == 0xff) {
    p += 2;
    out.clear();
    return true;
  }
  out.clear();
  while (p + 2 <= size) {
    uint16_t c = u16(data + p);
    p += 2;
    if (c == 0) break;
    if (c <= 0xff) out += (char)c;
    else out += '?';
  }
  return true;
}

static bool decode_string_block(const uint8_t* data, size_t size, uint32_t block_id,
                                std::unordered_map<uint32_t, std::string>& out, std::string* err) {
  const uint32_t base_id = block_id << 4;
  size_t p = 0;
  for (int slot = 0; slot < 16; slot++) {
    if (p + 2 > size) {
      if (p != size) return fail(err, "STRINGTABLE block " + std::to_string(block_id) + ": trailing bytes");
      break;
    }
    uint16_t len = u16(data + p);
    p += 2;
    if (len == 0) continue;
    if (p + (size_t)len * 2 > size)
      return fail(err, "STRINGTABLE block " + std::to_string(block_id) + " slot " + std::to_string(slot) +
                            ": length " + std::to_string(len) + " overruns block (" + std::to_string(size) + ")");
    const uint16_t* w = reinterpret_cast<const uint16_t*>(data + p);
    out[base_id + (uint32_t)slot] = wide_to_ansi(w, len);
    p += (size_t)len * 2;
  }
  if (p > size) return fail(err, "STRINGTABLE block " + std::to_string(block_id) + ": parse overrun");
  return true;
}

static void walk_resource_dir(const PeImage& pe, size_t dir_off, size_t rsrc_base, int level, uint32_t type_id,
                              uint32_t name_id, uint32_t lang_id, std::vector<DataLeaf>& leaves, std::string* err) {
  if (!bounds(pe, dir_off, 16)) {
    fail(err, "resource directory header past end of file");
    return;
  }
  uint16_t num_named = u16(pe.bytes.data() + dir_off + 12);
  uint16_t num_id = u16(pe.bytes.data() + dir_off + 14);
  size_t entries_off = dir_off + 16;
  size_t n = (size_t)num_named + num_id;
  if (!bounds(pe, entries_off, n * 8)) {
    fail(err, "resource directory entries past end of file");
    return;
  }
  for (size_t i = 0; i < n; i++) {
    const uint8_t* ent = pe.bytes.data() + entries_off + i * 8;
    uint32_t name_or_id = u32(ent);
    uint32_t data_off = u32(ent + 4);
    bool is_dir = (data_off & 0x80000000u) != 0;
    uint32_t rel = data_off & 0x7fffffffu;
    size_t target = rsrc_base + rel;
    if (!bounds(pe, target, 16u)) {
      fail(err, "resource entry offset out of range");
      return;
    }
    if (is_dir) {
      uint32_t t = type_id, nm = name_id, lg = lang_id;
      if (level == 0) t = name_or_id;
      else if (level == 1) nm = name_or_id;
      else if (level == 2) lg = name_or_id;
      walk_resource_dir(pe, target, rsrc_base, level + 1, t, nm, lg, leaves, err);
      if (err && !err->empty()) return;
    } else {
      const uint8_t* de = pe.bytes.data() + target;
      uint32_t data_rva = u32(de);
      uint32_t data_sz = u32(de + 4);
      size_t fo = 0;
      if (!rva_to_offset(pe, data_rva, &fo)) {
        fail(err, "resource data RVA not in any section");
        return;
      }
      if (!bounds(pe, fo, data_sz)) {
        fail(err, "resource data extends past end of file");
        return;
      }
      leaves.push_back({type_id, name_id, lang_id, fo, data_sz});
    }
  }
}

static void pick_best_leaf(const std::vector<DataLeaf>& leaves, std::unordered_map<uint32_t, DataLeaf>& out) {
  for (const DataLeaf& leaf : leaves) {
    auto it = out.find(leaf.name_id);
    if (it == out.end()) {
      out[leaf.name_id] = leaf;
    } else if (it->second.language_id != 1033 && leaf.language_id == 1033) {
      it->second = leaf;
    }
  }
}

static bool parse_dialog_template(const uint8_t* data, size_t size, uint32_t res_id, DialogTemplate& dlg,
                                  std::string* err) {
  if (size < 4) return fail(err, "dialog " + std::to_string(res_id) + " too small");
  size_t p = 0;
  uint16_t ver = u16(data + p);
  p += 2;
  uint16_t sig = u16(data + p);
  p += 2;
  bool is_ex = (ver == 1 && sig == kDlgSig);
  uint32_t style = 0;
  uint16_t num_items = 0;
  if (is_ex) {
    if (size < 26) return fail(err, "DLGTEMPLATEEX truncated");
    p += 4;  // helpID
    p += 4;  // exStyle
    style = u32(data + p);
    p += 4;
    num_items = u16(data + p);
    p += 2;
    p += 8;  // x,y,cx,cy
  } else {
    if (size < 18) return fail(err, "DLGTEMPLATE truncated");
    style = u32(data + p);
    p += 4;
    p += 4;  // exStyle
    num_items = u16(data + p);
    p += 2;
    p += 8;
  }
  std::string menu, cls, title;
  if (!read_wstr(data, size, p, menu)) return fail(err, "dialog menu string");
  if (!read_wstr(data, size, p, cls)) return fail(err, "dialog class string");
  if (!read_wstr(data, size, p, title)) return fail(err, "dialog title string");
  if (style & 0x40u) {
    if (p + 4 > size) return fail(err, "dialog font header");
    p += 2;  // point size
    p += 2;  // weight
    if (is_ex) {
      if (p + 2 > size) return fail(err, "dialog font charset");
      p += 2;  // italic + charset
    }
    std::string font;
    if (!read_wstr(data, size, p, font)) return fail(err, "dialog font face");
  }
  dlg.id = res_id;
  dlg.title = title;
  dlg.controls.clear();
  dlg.default_button_id = kIdok;
  for (uint16_t i = 0; i < num_items; i++) {
    if (is_ex) {
      if (p + 28 > size) return fail(err, "DLGITEMTEMPLATEEX truncated");
      p += 4;  // helpID
      p += 4;  // exStyle
      uint32_t istyle = u32(data + p);
      p += 4;
      p += 8;  // x,y,cx,cy
      uint32_t cid = u32(data + p);
      p += 4;
      std::string wc, text;
      if (!read_wstr(data, size, p, wc)) return fail(err, "control class");
      if (!read_wstr(data, size, p, text)) return fail(err, "control text");
      if (p + 2 > size) return fail(err, "control creation data");
      uint16_t extra = u16(data + p);
      p += 2;
      p += extra;
      DialogControl c{};
      c.id = cid;
      c.style = istyle;
      c.text = text;
      dlg.controls.push_back(c);
      if ((istyle & 0x0f) == kBsDefpushbutton) dlg.default_button_id = cid;
    } else {
      if (p + 18 > size) return fail(err, "DLGITEMTEMPLATE truncated");
      uint32_t istyle = u32(data + p);
      p += 4;
      p += 4;
      p += 8;
      uint16_t cid = u16(data + p);
      p += 2;
      std::string wc, text;
      if (!read_wstr(data, size, p, wc)) return fail(err, "control class");
      if (!read_wstr(data, size, p, text)) return fail(err, "control text");
      if (p + 2 > size) return fail(err, "control creation data");
      uint16_t extra = u16(data + p);
      p += 2;
      p += extra;
      DialogControl c{};
      c.id = cid;
      c.style = istyle;
      c.text = text;
      dlg.controls.push_back(c);
      if ((istyle & 0x0f) == kBsDefpushbutton) dlg.default_button_id = cid;
    }
  }
  return true;
}

static bool parse_pe(std::string* err) {
  std::string host = vfs_host_path(std::string(kGameDir) + "hitman.exe", false);
  if (host.empty()) return fail(err, "VFS cannot map BellaSara.exe (is vfs_init done?)");

  std::ifstream in(host, std::ios::binary);
  if (!in) return fail(err, "cannot open " + host);
  g_pe.bytes.assign(std::istreambuf_iterator<char>(in), std::istreambuf_iterator<char>());
  if (g_pe.bytes.size() < 0x40) return fail(err, "truncated PE");

  if (g_pe.bytes[0] != 'M' || g_pe.bytes[1] != 'Z') return fail(err, "missing MZ signature");
  uint32_t pe_off = u32(g_pe.bytes.data() + 0x3c);
  if (!bounds(g_pe, pe_off, 24)) return fail(err, "e_lfanew out of range");
  if (u32(g_pe.bytes.data() + pe_off) != 0x00004550u) return fail(err, "missing PE signature");

  uint16_t num_sections = u16(g_pe.bytes.data() + pe_off + 6);
  uint16_t opt_size = u16(g_pe.bytes.data() + pe_off + 20);
  size_t opt = pe_off + 24;
  if (!bounds(g_pe, opt, opt_size)) return fail(err, "optional header truncated");

  g_pe.image_base = u32(g_pe.bytes.data() + opt + 28);
  uint32_t num_rva = u32(g_pe.bytes.data() + opt + 92);
  if (num_rva <= kPeResourceDirIndex) return fail(err, "PE has no resource directory slot");

  size_t dir_base = opt + 96 + (size_t)kPeResourceDirIndex * 8;
  g_pe.resource_rva = u32(g_pe.bytes.data() + dir_base);
  g_pe.resource_size = u32(g_pe.bytes.data() + dir_base + 4);
  if (!g_pe.resource_rva || !g_pe.resource_size) return fail(err, "resource directory empty");

  size_t sec_base = opt + opt_size;
  if (!bounds(g_pe, sec_base, (size_t)num_sections * 40)) return fail(err, "section table truncated");

  g_pe.sections.clear();
  for (uint16_t i = 0; i < num_sections; i++) {
    const uint8_t* sh = g_pe.bytes.data() + sec_base + i * 40;
    Section s{};
    s.vsize = u32(sh + 8);
    s.va = u32(sh + 12);
    s.raw_size = u32(sh + 16);
    s.raw_off = u32(sh + 20);
    g_pe.sections.push_back(s);
  }

  size_t rsrc_off = 0;
  if (!rva_to_offset(g_pe, g_pe.resource_rva, &rsrc_off))
    return fail(err, "resource directory RVA not mapped");
  if (!bounds(g_pe, rsrc_off, g_pe.resource_size))
    return fail(err, "resource directory size exceeds file");

  uint32_t round = 0;
  if (!offset_to_rva(g_pe, rsrc_off, &round) || round != g_pe.resource_rva)
    return fail(err, "resource directory RVA<->offset round trip failed");

  std::vector<DataLeaf> all;
  std::string walk_err;
  walk_resource_dir(g_pe, rsrc_off, rsrc_off, 0, 0, 0, 0, all, &walk_err);
  if (!walk_err.empty()) return fail(err, walk_err);

  std::vector<DataLeaf> strings, icons, group_icons, cursors, group_cursors, menus, dialogs, versions;
  for (const DataLeaf& leaf : all) {
    switch (leaf.type_id) {
      case kRtString: strings.push_back(leaf); break;
      case kRtIcon: icons.push_back(leaf); break;
      case kRtGroupIcon: group_icons.push_back(leaf); break;
      case kRtCursor: cursors.push_back(leaf); break;
      case kRtGroupCursor: group_cursors.push_back(leaf); break;
      case kRtMenu: menus.push_back(leaf); break;
      case kRtDialog: dialogs.push_back(leaf); break;
      case kRtVersion: versions.push_back(leaf); break;
      default: break;
    }
  }

  g_icons.clear();
  g_group_icons.clear();
  g_cursors.clear();
  g_group_cursors.clear();
  g_menus.clear();
  g_dialogs.clear();
  g_versions.clear();
  g_dialog_templates.clear();
  pick_best_leaf(icons, g_icons);
  pick_best_leaf(group_icons, g_group_icons);
  pick_best_leaf(cursors, g_cursors);
  pick_best_leaf(group_cursors, g_group_cursors);
  pick_best_leaf(menus, g_menus);
  pick_best_leaf(dialogs, g_dialogs);
  pick_best_leaf(versions, g_versions);

  std::unordered_map<uint32_t, const DataLeaf*> best_strings;
  for (const DataLeaf& leaf : strings) {
    auto it = best_strings.find(leaf.name_id);
    if (it == best_strings.end()) best_strings[leaf.name_id] = &leaf;
    else if (it->second->language_id != 1033 && leaf.language_id == 1033) best_strings[leaf.name_id] = &leaf;
  }

  g_strings.clear();
  g_string_block_count = best_strings.size();
  for (const auto& [block_id, leaf] : best_strings) {
    if (!decode_string_block(g_pe.bytes.data() + leaf->offset, leaf->size, block_id, g_strings, err)) return false;
  }

  for (const auto& [id, leaf] : g_dialogs) {
    DialogTemplate dlg;
    if (!parse_dialog_template(g_pe.bytes.data() + leaf.offset, leaf.size, id, dlg, err)) return false;
    g_dialog_templates[id] = std::move(dlg);
  }

  return true;
}

static void ensure_open() {
  std::call_once(g_open_once, [] {
    g_open_ok = parse_pe(&g_open_error);
    if (!g_open_ok && g_open_error.empty()) g_open_error = "resource parse failed";
  });
}

static uint32_t make_icon_handle(uint32_t res_id) { return 0x00020100u + (res_id & 0xffu); }
static uint32_t make_cursor_handle(uint32_t res_id) { return 0x00020200u + (res_id & 0xffu); }

}  // namespace

bool resources_open(std::string* error) {
  ensure_open();
  if (!g_open_ok && error) *error = g_open_error;
  return g_open_ok;
}

int load_string(uint32_t id, char* buf, int maxlen) {
  if (maxlen < 0) return 0;
  if (!resources_open(nullptr)) return 0;
  auto it = g_strings.find(id);
  if (it == g_strings.end()) return 0;
  const std::string& s = it->second;
  int len = (int)s.size();
  if (maxlen == 0) return len;
  int copy = len;
  if (copy > maxlen - 1) copy = maxlen - 1;
  if (buf && copy >= 0) {
    if (copy > 0) std::memcpy(buf, s.data(), (size_t)copy);
    buf[copy] = '\0';
  }
  return copy;
}

bool resources_type_counts(ResourceTypeCounts* out) {
  if (!out) return false;
  if (!resources_open(nullptr)) return false;
  out->icons = g_icons.size();
  out->group_icons = g_group_icons.size();
  out->cursors = g_cursors.size();
  out->group_cursors = g_group_cursors.size();
  out->menus = g_menus.size();
  out->dialogs = g_dialogs.size();
  out->string_blocks = g_string_block_count;
  out->versions = g_versions.size();
  return true;
}

uint32_t resource_icon_handle(uint32_t res_id) {
  if (!resources_open(nullptr)) return 0;
  if (g_group_icons.count(res_id) || g_icons.count(res_id)) return make_icon_handle(res_id);
  return 0;
}

uint32_t resource_cursor_handle(uint32_t res_id) {
  if (!resources_open(nullptr)) return 0;
  if (g_group_cursors.count(res_id) || g_cursors.count(res_id)) return make_cursor_handle(res_id);
  return 0;
}

bool resource_has_group_icon(uint32_t res_id) {
  if (!resources_open(nullptr)) return false;
  return g_group_icons.count(res_id) != 0;
}

bool resource_has_icon(uint32_t res_id) {
  if (!resources_open(nullptr)) return false;
  return g_icons.count(res_id) != 0;
}

bool resource_has_menu(uint32_t res_id) {
  if (!resources_open(nullptr)) return false;
  return g_menus.count(res_id) != 0;
}

bool resource_has_dialog(uint32_t res_id) {
  if (!resources_open(nullptr)) return false;
  return g_dialog_templates.count(res_id) != 0;
}

uint32_t resource_stock_cursor_handle(uint32_t oem_id) {
  // IDC_ARROW (32512 / 0x7F00) and other standard cursors.
  if (oem_id >= 32512 && oem_id <= 32516) return make_cursor_handle(oem_id & 0xffu);
  return make_cursor_handle(oem_id & 0xffu);
}

int dialog_box_modal(Cpu* cpu, uint32_t template_id, uint32_t dlg_hwnd, uint32_t dlg_proc, uint32_t init_param) {
  if (!cpu || !dlg_proc) return -1;
  if (!resources_open(nullptr)) return -1;
  auto it = g_dialog_templates.find(template_id);
  if (it == g_dialog_templates.end()) return -1;

  g_active_dialog.hwnd = dlg_hwnd;
  g_active_dialog.template_id = template_id;
  g_active_dialog.control_text.clear();
  for (const DialogControl& c : it->second.controls) g_active_dialog.control_text[c.id] = c.text;

  guest_call(cpu, dlg_proc, {dlg_hwnd, kWmInitdialog, init_param, 0});
  uint32_t def_id = it->second.default_button_id ? it->second.default_button_id : kIdok;
  guest_call(cpu, dlg_proc, {dlg_hwnd, kWmCommand, def_id, 0});

  g_active_dialog = {};
  return (int)def_id;
}

int get_dlg_item_text(uint32_t dlg_hwnd, uint32_t item_id, char* buf, int maxlen) {
  if (maxlen < 0) return 0;
  if (g_active_dialog.hwnd != dlg_hwnd) return 0;
  auto it = g_active_dialog.control_text.find(item_id);
  const std::string& s = (it != g_active_dialog.control_text.end()) ? it->second : std::string();
  int len = (int)s.size();
  if (maxlen == 0) return len;
  int copy = len;
  if (copy > maxlen - 1) copy = maxlen - 1;
  if (buf) {
    if (copy > 0) std::memcpy(buf, s.data(), (size_t)copy);
    buf[copy] = '\0';
  }
  return copy;
}

bool resources_pe_rva_to_offset(uint32_t rva, size_t* offset_out) {
  if (!resources_open(nullptr)) return false;
  return rva_to_offset(g_pe, rva, offset_out);
}

bool resources_pe_offset_to_rva(size_t offset, uint32_t* rva_out) {
  if (!resources_open(nullptr)) return false;
  return offset_to_rva(g_pe, offset, rva_out);
}

bool resources_pe_resource_directory(uint32_t* rva, uint32_t* size) {
  if (!resources_open(nullptr)) return false;
  if (rva) *rva = g_pe.resource_rva;
  if (size) *size = g_pe.resource_size;
  return g_pe.resource_rva != 0;
}

struct StringLeaf {
  uint32_t block_id;
  uint32_t language_id;
  size_t offset;
  size_t size;
};

static void walk_string_tables(const PeImage& pe, size_t rsrc_off, std::vector<StringLeaf>& strings, std::string* err) {
  std::vector<DataLeaf> leaves;
  walk_resource_dir(pe, rsrc_off, rsrc_off, 0, 0, 0, 0, leaves, err);
  for (const DataLeaf& leaf : leaves) {
    if (leaf.type_id == kRtString)
      strings.push_back({leaf.name_id, leaf.language_id, leaf.offset, leaf.size});
  }
}

void resources_foreach_string_table(const std::function<void(const ResourcesStringTable&)>& fn) {
  if (!resources_open(nullptr)) return;
  size_t rsrc_off = 0;
  if (!rva_to_offset(g_pe, g_pe.resource_rva, &rsrc_off)) return;
  std::vector<StringLeaf> leaves;
  std::string err;
  walk_string_tables(g_pe, rsrc_off, leaves, &err);
  for (const StringLeaf& leaf : leaves) {
    ResourcesStringTable t{};
    t.block_id = leaf.block_id;
    t.language_id = leaf.language_id;
    t.offset = leaf.offset;
    t.size = leaf.size;
    fn(t);
  }
}

void resources_foreach_string(const std::function<void(uint32_t id, const std::string& utf8)>& fn) {
  if (!resources_open(nullptr)) return;
  for (const auto& [id, s] : g_strings) fn(id, s);
}

}  // namespace rt
