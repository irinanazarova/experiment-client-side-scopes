# frozen_string_literal: true

class ApplicationController < ActionController::Base
  # Only allow modern browsers supporting webp images, web push, badges, import
  # maps, CSS nesting, and CSS :has.
  allow_browser versions: :modern

  # Changes to the importmap will invalidate the etag for HTML responses.
  stale_when_importmap_changes

  # Action Policy authorization context. POC: single trusted (anonymous) user;
  # real auth populates current_user and the policy predicates do the rest.
  # `user` is declared optional in ApplicationPolicy, so nil is allowed.
  authorize :user, through: :current_user

  private

  def current_user
    nil
  end
end
