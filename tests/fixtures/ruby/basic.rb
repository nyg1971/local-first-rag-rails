class User < ApplicationRecord
  def greet
    "Hello, #{name}!"
  end

  def farewell
    say_goodbye()
    "Goodbye!"
  end
end
