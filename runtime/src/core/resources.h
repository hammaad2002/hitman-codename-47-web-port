// PE resource directory for the installed BellaSara.exe (icons, dialogs, menus, strings, …).
// Parsed from the on-disk image via the VFS; see work/RESOURCE-NOTES.md.
#pragma once

#include <cstdint>
#include <functional>
#include <string>

struct Cpu;  // guest CPU (recomp.h); kept at global scope to avoid clashing with HLE handlers.

namespace rt {

// Lazy-open the main executable's .rsrc section and index resources. Thread-safe;
// repeated calls are cheap. On failure sets *error and returns false (parse errors never throw).
bool resources_open(std::string* error);

// Win32 LoadStringA semantics: returns number of characters placed in buf (not counting the
// terminating NUL), 0 if the id is absent. When maxlen==0, buf is not read and the length that
// would have been copied is returned. Truncation NUL-terminates and returns maxlen - 1.
int load_string(uint32_t id, char* buf, int maxlen);

// Parsed resource counts (unique name ids per type, language leaves collapsed).
struct ResourceTypeCounts {
  size_t icons = 0;
  size_t group_icons = 0;
  size_t cursors = 0;
  size_t group_cursors = 0;
  size_t menus = 0;
  size_t dialogs = 0;
  size_t string_blocks = 0;
  size_t versions = 0;
};

bool resources_type_counts(ResourceTypeCounts* out);

// Guest resource id (numeric MAKEINTRESOURCE). Returns 0 when absent.
uint32_t resource_icon_handle(uint32_t res_id);
uint32_t resource_cursor_handle(uint32_t res_id);
bool resource_has_group_icon(uint32_t res_id);
bool resource_has_icon(uint32_t res_id);
bool resource_has_menu(uint32_t res_id);
bool resource_has_dialog(uint32_t res_id);

// Stock OEM cursors (IDC_*) when no RT_CURSOR entry exists.
uint32_t resource_stock_cursor_handle(uint32_t oem_id);

// Modal dialog simulation for DialogBoxParamA (WM_INITDIALOG + default-button WM_COMMAND).
// Returns the dialog result (e.g. IDOK=1) or -1 on failure.
int dialog_box_modal(Cpu* cpu, uint32_t template_id, uint32_t dlg_hwnd, uint32_t dlg_proc, uint32_t init_param);

// GetDlgItemTextA during an active dialog_box_modal call.
int get_dlg_item_text(uint32_t dlg_hwnd, uint32_t item_id, char* buf, int maxlen);

// ---- resources_test.cpp hooks (same parser the HLE uses) ------------------------------------
bool resources_pe_rva_to_offset(uint32_t rva, size_t* offset_out);
bool resources_pe_offset_to_rva(size_t offset, uint32_t* rva_out);
bool resources_pe_resource_directory(uint32_t* rva, uint32_t* size);

struct ResourcesStringTable {
  uint32_t block_id;   // STRINGTABLE block (string ids block_id<<4 .. +15)
  uint32_t language_id;
  size_t offset;       // file offset of the raw block bytes
  size_t size;
};

void resources_foreach_string_table(const std::function<void(const ResourcesStringTable&)>& fn);
void resources_foreach_string(const std::function<void(uint32_t id, const std::string& utf8)>& fn);

}  // namespace rt
