user = User.find_by(username: 'root')
raise 'root user not found' unless user

existing = user.personal_access_tokens.find_by(name: 'agent-mcp')
if existing
  puts 'PAT already exists — skipping'
else
  token = PersonalAccessToken.new(
    user: user,
    name: 'agent-mcp',
    scopes: ['api', 'read_repository', 'write_repository'],
    expires_at: 1.year.from_now,
  )
  token.set_token(ENV.fetch('TOKEN'))
  token.save!
  puts 'PAT created successfully'
end
