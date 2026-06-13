# frozen_string_literal: true

# Packing for the PUBLIC slice. app.wasm is downloadable by anyone, so whatever
# is packed is exposed source. wasmify maps ALL of config/ into the module
# (wasi-vfs --dir config::...), which would embed config/master.key (the key that
# decrypts credentials) and the encrypted credentials file. This task packs with
# those removed, and FAILS LOUDLY if the master key still ends up in the output,
# so a leak can never ship.
#
# It also keeps the payload lean: the /wasm_ar demo's ruby-app.wasm (bundled via
# public/) and the packed app.wasm itself are debug-stripped, dropping ~19 MB of
# DWARF/name sections from each.
#
# Always use `bin/rails slice:pack`, never `bin/rails wasmify:pack`, to build the
# slice. The in-VM Rails does not need the key (config/environments/wasm.rb sets
# a non-secret secret_key_base and require_master_key = false).
namespace :slice do
  desc "Pack app.wasm for the public slice: secrets excluded, demo + app wasm debug-stripped (use instead of wasmify:pack)"
  task pack: :environment do
    mb = ->(bytes) { (bytes / 1_048_576.0).round(1) }

    # wasm-strip removes the debug/name custom sections only, with no
    # re-serialization of code/data, so it cannot change runtime behavior.
    # Shared by both strips below; a no-op (with a warning) when wabt is absent.
    strip = lambda do |path, label|
      unless system("which wasm-strip > /dev/null 2>&1")
        return warn("slice:pack: wasm-strip not found (brew install wabt) — #{label} ships ~19 MB larger")
      end
      before = path.size
      if system("wasm-strip", path.to_s)
        puts "slice:pack stripped #{label}: #{mb.(before)} MB -> #{mb.(path.size)} MB"
      else
        warn "slice:pack: wasm-strip failed on #{label} (exit #{$?.exitstatus})"
      end
    end

    # The /wasm_ar demo's ruby-app.wasm is built unstripped by rbwasm (in
    # wasm_build/) and packed into app.wasm via public/, and is also served by
    # the host's /wasm_ar page. Strip it in place so both ship lean, regardless
    # of how it was last built. Keeping it (stripped) in the slice is safe;
    # removing it from public/ entirely hangs the in-VM Rails boot (wasi-vfs).
    ruby_app = Rails.root.join("public/ruby-app.wasm")
    strip.(ruby_app, "public/ruby-app.wasm") if ruby_app.exist?

    # Stash secrets OUTSIDE the packed directories (tmp/ is not in
    # pack_directories), or wasi-vfs would just pack the backup too.
    stash_dir = Rails.root.join("tmp")
    secret_files = %w[config/master.key config/credentials.yml.enc]
      .map { |f| Rails.root.join(f) }.select(&:exist?)
    stashed = secret_files.map { |path| [path, stash_dir.join("#{path.basename}.nopack")] }

    stashed.each { |path, backup| FileUtils.mv(path, backup) }
    begin
      Rake::Task["wasmify:pack"].invoke
    ensure
      # Always restore the working tree, even if packing fails.
      stashed.each { |path, backup| FileUtils.mv(backup, path) if backup.exist? }
    end

    wasm = Rails.root.join("pwa/public/app.wasm")
    strip.(wasm, "app.wasm custom sections") if wasm.exist?

    # Safety net: prove the secret is not in the shipped artifact. grep runs in
    # this process (no secret is printed); a match aborts the build.
    key = Rails.root.join("config/master.key")
    if key.exist? && wasm.exist? && system("grep", "-aqf", key.to_s, wasm.to_s)
      raise "SECURITY: master key bytes found in #{wasm} — refusing to ship."
    end

    puts "slice:pack OK — verified no master key in pwa/public/app.wasm"
  end
end
