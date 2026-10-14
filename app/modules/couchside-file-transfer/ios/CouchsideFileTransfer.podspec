Pod::Spec.new do |s|
  s.name = 'CouchsideFileTransfer'
  s.version = '0.1.0'
  s.summary = 'Pinned HTTPS file uploads to a paired Couchside box'
  s.description = s.summary
  s.license = { :type => 'SEE LICENSE IN ../../../LICENSE' }
  s.author = 'Couchside'
  s.homepage = 'https://couchside.tv'
  s.platforms = { :ios => '16.4' }
  s.swift_version = '5.9'
  s.source = { :git => 'https://github.com/emerytech/couchside.git' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '*.swift'
end
