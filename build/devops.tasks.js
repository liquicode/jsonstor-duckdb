'use strict';

module.exports = {

	Context: {
		Package: require( '../package.json' ),
		AWS_ProfileName: 'admin',
		AWS_BucketName: '',
	},

	// run_tests lives in jsonstor-docs now, along with the tests themselves.
	//
	// Every test in this family is in that one repository: the questions asked of one
	// adapter are the questions asked of every adapter, and one copy of them is what makes
	// two engines' results comparable. There is nothing here to run.
	//
	// Run 'npm test -w jsonstor-docs.git' before publishing this package.


	// build_docs lives in jsonstor-docs now.
	//
	// This repository's readme.md is generated from the adapter inventory at
	// jsonstor-docs/docs/data/adapters.js. Edit it there.


	// There is deliberately no run_webpack task.
	//
	// The sibling adapters carry one pointing at build/webpack.config.js, in repositories
	// which have no such file, and every caller has it commented out. A build step which
	// cannot run is indistinguishable from one nobody runs, so this repository starts
	// without it rather than inheriting it.

	update_aws_docs: [

		// Update aws s3 bucket with package docs.
		{
			$Shell: {
				command: 'set "AWS_PROFILE=${AWS_ProfileName}" & aws s3 sync docs s3://${AWS_BucketName}',
				out: { console: true },
				err: { console: true },
			},
		},

	],

	npm_publish_version: [

		// Update npmjs.com with new package.
		{
			$Shell: {
				command: 'npm publish . --access public',
				out: { console: true },
				err: { console: true },
				halt_on_error: false
			}
		},

	],

	git_publish_version: [

		// Update github and finalize the version.
		{
			$Shell: {
				command: 'git add .',
				out: { console: true },
				err: { console: true },
				halt_on_error: false
			}
		},
		{
			$Shell: {
				command: 'git commit --quiet -m "Finalization for v${Package.version}"',
				out: { console: true },
				err: { console: true },
				halt_on_error: false
			}
		},
		{
			$Shell: {
				command: 'git push --quiet origin main',
				out: { console: true },
				err: { console: true },
				halt_on_error: false
			}
		},
		// Tag the existing version
		{
			$Shell: {
				command: 'git tag -a v${Package.version} -m "Version v${Package.version}"',
				out: { console: true },
				err: { console: true },
				halt_on_error: false
			}
		},
		{
			$Shell: {
				command: 'git push --quiet origin v${Package.version}',
				out: { console: true },
				err: { console: true },
				halt_on_error: false
			}
		},

	],

	publish_version: [

		// Finalize and publish the existing version.
		{ $RunTask: { task: 'git_publish_version' } },
		{ $RunTask: { task: 'npm_publish_version' } },

	],

	start_new_version: [

		// Increment and update the official package version.
		{ $SemverInc: { context: 'Package.version' } },
		{
			$PrintContext: {
				context: 'Package',
				out: { as: 'json-friendly', filename: 'package.json' },
			}
		},

		// Reload the package file.
		{
			$ReadJsonFile: {
				filename: 'package.json',
				out: { context: 'Package' },
			}
		},

		// Update github with the new version.
		{
			$Shell: {
				command: 'git add .',
				out: { console: true },
				err: { console: true },
				halt_on_error: false
			}
		},
		{
			$Shell: {
				command: 'git commit --quiet -m "Initialization for v${Package.version}"',
				out: { console: true },
				err: { console: true },
				halt_on_error: false
			}
		},
		{
			$Shell: {
				command: 'git push --quiet origin main',
				out: { console: true },
				err: { console: true },
				halt_on_error: false
			}
		},

	],

};
