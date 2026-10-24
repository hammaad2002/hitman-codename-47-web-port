// Multi-module loader for the Hitman: Codename 47 module set.
#pragma once

#include <cstdint>
#include <functional>
#include <string>
#include <vector>

struct Cpu;

namespace rt {

struct ModuleSpec {
    const char* name;
    uint32_t preferred_base;
    uint32_t load_base;
};

struct ModuleInfo {
    std::string name;
    uint32_t preferred_base;
    uint32_t load_base;
    uint32_t size;
    uint32_t entry_rva;
    bool init_ran;
};

void load_modules(const std::function<bool(const std::string& name, std::vector<uint8_t>& out)>& read_file);

uint32_t module_base(const std::string& name);

uint32_t module_export(uint32_t base, const std::string& name_or_hash_ordinal);

void run_module_inits();
void run_module_init(uint32_t base, Cpu* c);  // DllMain(PROCESS_ATTACH) once; no-op if already run

size_t import_count();

struct Import {
    std::string dll, name;
    uint32_t slot;
    void* fn;  // HleFn, but avoid circular dependency
    bool is_set_module;
};

const Import& import_at(size_t index);

size_t module_count();

const ModuleInfo& module_at(size_t index);

}  // namespace rt