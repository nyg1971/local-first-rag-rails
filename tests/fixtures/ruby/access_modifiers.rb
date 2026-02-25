class User
  def public_action
    "public"
  end

  private

  def secret_action
    "private"
  end

  protected

  def guarded_action
    "protected"
  end
end
