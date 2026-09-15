# Self-contained rather than reading a package.json, because a LOCAL module
# has none — autolinking resolves a directory under `modules/` by its folder
# name and never looks for one. The npm-shipped modules in node_modules all
# parse `../package.json` here; copying that would break on the one
# difference that matters.

Pod::Spec.new do |s|
  s.name           = 'PhoneSetup'
  s.version        = '1.0.0'
  s.summary        = 'Reads and repairs the phone settings that silently stop background location.'
  s.description    = 'Android-only in substance; the iOS half is an honest stub. See PhoneSetupModule.swift.'
  s.author         = 'Mahek Marketing India'
  s.homepage       = 'https://one.mahekindia.com'
  s.platforms      = { :ios => '15.1', :tvos => '15.1' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
