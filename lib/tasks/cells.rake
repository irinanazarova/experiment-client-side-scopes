# frozen_string_literal: true

namespace :cells do
  desc "Simulate background server activity: set a random 5-cell section to a random value every two seconds"
  task simulate: :environment do
    sheet = Sheet.first or abort "No sheet to simulate on (run db:seed)."

    interval = Float(ENV.fetch("TICK_INTERVAL", "2"))
    tick = Cells::RandomTick.new(sheet) # default window: always on the first screen

    $stdout.sync = true
    puts "Simulating server writes on sheet ##{sheet.id} every #{interval}s " \
         "(rows #{Cells::RandomTick::VISIBLE_ROWS}, cols #{Cells::RandomTick::VISIBLE_COLS}). Ctrl-C to stop."

    trap("INT") do
      puts "\nstopped"
      exit
    end

    loop do
      tick.call
      print "·"
      sleep interval
    end
  end
end
