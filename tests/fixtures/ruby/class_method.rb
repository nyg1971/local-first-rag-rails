class User
  def self.find_by_email(email)
    where(email: email).first
  end

  def instance_method
    "hello"
  end
end
