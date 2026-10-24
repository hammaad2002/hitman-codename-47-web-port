// Multi-module loader: loads the Hitman module set, applies relocations, fills IATs,
// builds the HLE import index (matching recomp/src/peset.ts order), and runs DllMain.
#include <algorithm>
#include <cstdint>
#include <cstring>
#include <functional>
#include <map>
#include <mutex>
#include <string>
#include <vector>

#include "modules.h"
#include "rt.h"

namespace rt {

struct Module {
    std::string name;
    uint32_t preferred_base;
    uint32_t load_base;
    uint32_t size;
    uint32_t entry_rva;
    std::vector<uint8_t> image;
    bool init_ran = false;
};

static std::vector<Module> g_modules;
static std::map<uint32_t, size_t> g_base_to_module;
static std::vector<Import> g_imports;  // HLE imports only (the recompiler's import index)
struct SetImport { std::string dll, name; uint32_t slot; };
static std::vector<SetImport> g_set_imports;
static uint32_t g_entry = 0;
static uint32_t g_image_end = 0;

static uint32_t u16(const uint8_t* p) {
    return p[0] | (p[1] << 8);
}

static uint32_t u32(const uint8_t* p) {
    return p[0] | (p[1] << 8) | (p[2] << 16) | (p[3] << 24);
}

static std::string lower(std::string s) {
    for (auto& ch : s) ch = (char)tolower((unsigned char)ch);
    return s;
}

static void parse_pe_header(const uint8_t* exe, size_t exe_size, uint32_t& pe_off, uint32_t& nsec, uint32_t& optsz, uint32_t& opt_off, uint32_t& base, uint32_t& size, uint32_t& hdrsz, uint32_t& entry_rva) {
    pe_off = u32(exe + 0x3c);
    if (pe_off + 4 > exe_size || u32(exe + pe_off) != 0x4550) fatal("not a PE image");
    nsec = u16(exe + pe_off + 6);
    optsz = u16(exe + pe_off + 20);
    opt_off = pe_off + 24;
    if (u16(exe + opt_off) != 0x10b) fatal("not PE32");
    entry_rva = u32(exe + opt_off + 16);
    base = u32(exe + opt_off + 28);
    size = u32(exe + opt_off + 56);
    hdrsz = u32(exe + opt_off + 60);
}

static void map_sections(const Module& mod, const uint8_t* exe, size_t exe_size, uint32_t opt_off, uint32_t optsz, uint32_t nsec, uint32_t hdrsz) {
    uint32_t base = mod.load_base;
    uint32_t so = opt_off + optsz;
    size_t copy_hdrs = std::min<size_t>(hdrsz, exe_size);
    memcpy(host(base), exe, copy_hdrs);
    for (uint32_t i = 0; i < nsec; i++) {
        uint32_t sh = so + 40 * i;
        uint32_t vs = u32(exe + sh + 8);
        uint32_t va = u32(exe + sh + 12);
        uint32_t rs = u32(exe + sh + 16);
        uint32_t ro = u32(exe + sh + 20);
        memset(host(base + va), 0, vs);
        uint32_t n = std::min(rs, vs ? vs : rs);
        if (ro + n > exe_size) n = (uint32_t)exe_size - ro;
        if (n > 0) memcpy(host(base + va), exe + ro, n);
    }
}

static void apply_relocations(Module& mod) {
    if (mod.load_base == mod.preferred_base) return;
    uint32_t delta = mod.load_base - mod.preferred_base;
    uint32_t pe = u32(mod.image.data() + 0x3c);
    uint32_t opt = pe + 24;
    uint32_t reloc_rva = u32(mod.image.data() + opt + 136);
    uint32_t reloc_size = u32(mod.image.data() + opt + 140);
    if (!reloc_rva || !reloc_size) return;
    uint32_t reloc_va = mod.load_base + reloc_rva;
    for (uint32_t off = 0; off < reloc_size;) {
        uint32_t block_va = reloc_va + off;
        uint32_t page_rva = ld32(block_va);
        uint32_t block_sz = ld32(block_va + 4);
        if (!block_sz) break;
        uint32_t count = (block_sz - 8) / 2;
        for (uint32_t i = 0; i < count; i++) {
            uint16_t entry = ld16(block_va + 8 + 2 * i);
            uint32_t type = entry >> 12;
            uint32_t offset = entry & 0xfff;
            if (type == 3) {  // IMAGE_REL_BASED_HIGHLOW
                uint32_t* p = (uint32_t*)host(mod.load_base + page_rva + offset);
                *p += delta;
            }
        }
        off += block_sz;
    }
}

static uint32_t find_export(uint32_t base, const std::string& name_or_ordinal) {
    uint32_t pe = u32(host(base) + 0x3c);
    uint32_t opt = pe + 24;
    uint32_t exp_rva = u32(host(base) + opt + 96);
    uint32_t exp_size = u32(host(base) + opt + 100);
    if (!exp_rva || !exp_size) return 0;
    uint32_t exp_va = base + exp_rva;
    uint32_t base_ord = ld32(exp_va + 16), nfuncs = ld32(exp_va + 20), nnames = ld32(exp_va + 24);
    uint32_t addr_rva = ld32(exp_va + 28), name_rva = ld32(exp_va + 32), ord_rva = ld32(exp_va + 36);
    uint32_t idx = nfuncs;
    if (name_or_ordinal[0] == '#') {
        uint32_t ord = (uint32_t)std::stoul(name_or_ordinal.substr(1));
        if (ord >= base_ord) idx = ord - base_ord;
    } else {
        for (uint32_t i = 0; i < nnames; i++) {
            if (name_or_ordinal == read_cstr(base + ld32(base + name_rva + i * 4))) { idx = ld16(base + ord_rva + i * 2); break; }
        }
    }
    if (idx >= nfuncs) return 0;
    uint32_t rva = ld32(base + addr_rva + idx * 4);
    // shortcut: export forwarders (RVA inside the export directory) are not followed; none expected in the set.
    return rva ? base + rva : 0;
}

static void collect_imports(Module& mod) {
    uint32_t base = mod.load_base;
    uint32_t pe = u32(host(base) + 0x3c);
    uint32_t imp_rva = u32(host(base) + pe + 24 + 104);
    if (!imp_rva) return;
    for (uint32_t d = base + imp_rva;; d += 20) {
        uint32_t name_rva = ld32(d + 12);
        if (!name_rva) break;
        std::string dll = lower(read_cstr(base + name_rva));
        bool is_set_module = module_base(dll) != 0;
        uint32_t iat = ld32(d + 16);
        uint32_t lookup = ld32(d) ? ld32(d) : iat;
        for (uint32_t k = 0;; k++) {
            uint32_t t = ld32(base + lookup + 4 * k);
            if (!t) break;
            std::string name = (t & 0x80000000u) ? "#" + std::to_string(t & 0xffff) : read_cstr(base + t + 2);
            uint32_t slot = base + iat + 4 * k;
            if (is_set_module) g_set_imports.push_back({dll, name, slot});
            else g_imports.push_back({dll, name, slot, (void*)hle_find(dll, name), false});
        }
    }
}

void load_modules(const std::function<bool(const std::string& name, std::vector<uint8_t>& out)>& read_file) {
    static const ModuleSpec kModuleTable[] = {
        {"hitman.exe", 0x00400000, 0x00400000},
        {"Globals.dll", 0x0fff0000, 0x0fff0000},
        {"system.dll", 0x0ffa0000, 0x0ffa0000},
        {"EngineData.dll", 0x0ff60000, 0x0ff60000},
        {"gsc.dll", 0x0fbf0000, 0x0fbf0000},
        {"Sound.dll", 0x0ff30000, 0x0ff30000},
        {"Locale.dll", 0x0fbd0000, 0x0fbd0000},
        {"RenderOpenGL.dll", 0x0fb70000, 0x0fb70000},
        {"xmlparse.dll", 0x20000000, 0x0fb50000},
        {"HitmanDlc.dlc", 0x0fcc0000, 0x0f800000},
    };

    g_modules.clear();
    g_imports.clear();
    g_set_imports.clear();
    g_entry = g_image_end = 0;

    for (const auto& spec : kModuleTable) {
        std::vector<uint8_t> data;
        if (!read_file(spec.name, data)) fatal("failed to read %s", spec.name);
        uint32_t pe_off, nsec, optsz, opt_off, base, size, hdrsz, entry_rva;
        parse_pe_header(data.data(), data.size(), pe_off, nsec, optsz, opt_off, base, size, hdrsz, entry_rva);
        if (base != spec.preferred_base) fatal("%s: unexpected preferred base %08x", spec.name, base);

        Module mod;
        mod.name = spec.name;
        mod.preferred_base = spec.preferred_base;
        mod.load_base = spec.load_base;
        mod.size = size;
        mod.entry_rva = entry_rva;
        if (mod.name == "hitman.exe") g_entry = mod.load_base + entry_rva;
        g_image_end = std::max(g_image_end, mod.load_base + size);
        map_sections(mod, data.data(), data.size(), opt_off, optsz, nsec, hdrsz);
        mod.image = std::move(data);
        g_modules.push_back(std::move(mod));
        vm_reserve_image(spec.load_base, size);
        apply_relocations(g_modules.back());
    }

    for (auto& mod : g_modules) collect_imports(mod);

    for (auto& im : g_set_imports) {
        uint32_t exp = find_export(module_base(im.dll), im.name);
        if (!exp) fatal("export %s not found in %s", im.name.c_str(), im.dll.c_str());
        st32(im.slot, exp);
    }
    size_t missing = 0;
    for (auto& im : g_imports) {
        if (!im.fn) missing++;
        HleFn fn = (HleFn)im.fn;
        st32(im.slot, make_thunk(fn ? std::function<void(Cpu*)>(fn) : std::function<void(Cpu*)>(), im.dll + "!" + im.name));
    }
    log(Log::Info, "modules loaded: entry %08x, image_end %08x, %zu HLE imports (%zu not implemented), %zu intra-set",
        g_entry, g_image_end, g_imports.size(), missing, g_set_imports.size());
}

uint32_t module_base(const std::string& name) {
    std::string n = lower(name);
    size_t slash = n.find_last_of("\\/");  // LoadLibrary("C:\\Games\\Hitman\\EngineData.dll")
    if (slash != std::string::npos) n = n.substr(slash + 1);
    if (n.find('.') == std::string::npos) n += ".dll";
    for (const auto& m : g_modules) if (lower(m.name) == n) return m.load_base;
    return 0;
}

uint32_t module_export(uint32_t base, const std::string& name_or_hash_ordinal) {
    return find_export(base, name_or_hash_ordinal);
}

void run_module_init(uint32_t base, Cpu* c) {
    for (auto& mod : g_modules) {
        if (mod.load_base != base || mod.name == "hitman.exe" || mod.init_ran || !mod.entry_rva) continue;
        mod.init_ran = true;
        guest_call(c, mod.load_base + mod.entry_rva, {mod.load_base, 1, 0});  // DLL_PROCESS_ATTACH
    }
}

void run_module_inits() {
    GuestThread* t = current_thread();
    if (!t) fatal("run_module_inits needs a bound guest thread");
    for (auto& mod : g_modules) run_module_init(mod.load_base, &t->cpu);
}

uint32_t image_entry() { return g_entry; }
uint32_t image_end() { return g_image_end; }

std::vector<ImportInfo> import_list() {
    std::vector<ImportInfo> v;
    for (const auto& im : g_imports) v.push_back({im.dll, im.name, im.fn != nullptr});
    return v;
}

size_t import_count() { return g_imports.size(); }
const Import& import_at(size_t index) { return g_imports[index]; }
size_t module_count() { return g_modules.size(); }

const ModuleInfo& module_at(size_t index) {
    static thread_local ModuleInfo info;
    const auto& m = g_modules[index];
    info = {m.name, m.preferred_base, m.load_base, m.size, m.entry_rva, m.init_ran};
    return info;
}

}  // namespace rt
