# frozen_string_literal: true

# Packing for the PUBLIC slice. app.wasm is downloadable by anyone, so whatever
# is packed is exposed source. wasmify maps ALL of config/ into the module
# (wasi-vfs --dir config::...), which would embed config/master.key (the key that
# decrypts credentials) and the encrypted credentials file. This task packs with
# those removed, and FAILS LOUDLY if the master key still ends up in the output,
# so a leak can never ship.
#
# Always use `bin/rails slice:pack`, never `bin/rails wasmify:pack`, to build the
# slice. The in-VM Rails does not need the key (config/environments/wasm.rb sets
# a non-secret secret_key_base and require_master_key = false).
namespace :slice do
  desc "Pack app.wasm for the public slice with secrets excluded (use instead of wasmify:pack)"
  task pack: :environment do
    # Stash backups OUTSIDE the packed directories (tmp/ is not in
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

    # Safety net: prove the secret is not in the shipped artifact. grep runs in
    # this process (no secret is printed); a match aborts the build.
    key = Rails.root.join("config/master.key")
    wasm = Rails.root.join("pwa/public/app.wasm")
    if key.exist? && wasm.exist? && system("grep", "-aqf", key.to_s, wasm.to_s)
      raise "SECURITY: master key bytes found in #{wasm} — refusing to ship."
    end

    puts "slice:pack OK — verified no master key in pwa/public/app.wasm"
  end
end
