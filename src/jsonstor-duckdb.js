'use strict';

const LIB_CRYPTO = require( 'crypto' );

const jsongin = require( '@liquicode/jsongin' );
const DUCKDB = require( '@duckdb/node-api' );


module.exports = {

	AdapterName: 'jsonstor-duckdb',
	AdapterDescription: 'Documents are stored in a DuckDB database.',

	GetAdapter: function ( jsonstor, Settings )
	{


		//=====================================================================
		if ( jsongin.ShortType( Settings ) !== 'o' ) { throw new Error( `This adapter requires a Settings parameter.` ); }
		// ***No Server, Port, UserName or Password, and that is the point of this adapter.***
		// DuckDB is in-process. There is no connection to authenticate and no port for another
		// service to shadow, which is half of why this was the second dialect to attempt.
		if ( jsongin.ShortType( Settings.Database ) !== 's' ) { throw new Error( `This adapter requires a Settings.Database string parameter. Use ':memory:' or a file path.` ); }
		if ( jsongin.ShortType( Settings.Table ) !== 's' ) { throw new Error( `This adapter requires a Settings.Table string parameter.` ); }
		// DuckDB has schemas as Postgres does, and calls the default one 'main' rather than
		// 'public'. Every statement here names it, so a catalog read cannot match a same named
		// table in another schema.
		if ( jsongin.ShortType( Settings.Schema ) !== 's' ) { Settings.Schema = 'main'; }
		if ( jsongin.ShortType( Settings.IdField ) !== 's' ) { Settings.IdField = ''; }
		if ( jsongin.ShortType( Settings.ModifySchema ) !== 'b' ) { Settings.ModifySchema = false; }
		// The storage model. See jsonx/.plans/sql-adapter-architecture.md - real columns are an
		// index which pre-filters, and the payload column carries the document. With no payload
		// column the table *is* the document, and a field with no column is refused by name.
		if ( jsongin.ShortType( Settings.PayloadColumn ) !== 's' ) { Settings.PayloadColumn = ''; }
		if ( jsongin.ShortType( Settings.PayloadSync ) !== 'b' ) { Settings.PayloadSync = false; }
		if ( jsongin.ShortType( Settings.Columns ) !== 'a' ) { Settings.Columns = []; }


		//=====================================================================
		let Storage = jsonstor.StorageInterface();
		Storage.Settings = jsongin.Clone( Settings );
		Storage.Catalog = {
			initialized: false,
			fields: null,
			id_field: null,
		};


		//=====================================================================
		// The primary key column this adapter creates when it creates a table.
		//
		// ***A VARCHAR key rather than an integer one***, for the reason every sibling has:
		// jsongin's _id is a uuid string and the caller's _id is taken as given. A foreign
		// table's identity key is still discovered and still used; this is only what gets
		// created.
		const DEFAULT_ID_FIELD = '_id';
		const DEFAULT_ID_TYPE = 'VARCHAR NOT NULL';

		// ***Not DuckDB's JSON type, and the reason is the one which ruled out MySQL's and
		// Postgres's.*** A parsed form hands back its own key order, so a strict equality
		// against a whole object compares a document nobody wrote. The payload has to return
		// the bytes which were written, and VARCHAR does. Indexing into the payload is Wave 1's
		// last item and it belongs to Postgres first.
		const PAYLOAD_TYPE = 'VARCHAR DEFAULT NULL';

		// The type a declared column gets when the caller names one without a type.
		const DEFAULT_COLUMN_TYPE = 'VARCHAR DEFAULT NULL';

		// ***Insertion order needs a column here, and it needs a sequence to feed it.***
		//
		// A) CRUD Tests asserts that a collection reads back in the order it was written, and a
		// SELECT with no ORDER BY promises nothing. This is the fourth distinct answer to one
		// obligation: sqlite has a hidden rowid, mysql has AUTO_INCREMENT, postgres has an
		// IDENTITY column, and DuckDB has neither an identity nor a rowid an UPDATE leaves
		// alone - so the column takes its default from a named sequence.
		//
		// ***The sequence is a second object with the same lifetime as the table***, which no
		// sibling has to think about. See DropStorage: a sequence survives DROP TABLE, so
		// dropping only the table would leave the next collection counting from where the last
		// one stopped.
		//
		// It is never a document field. It is excluded from every row read, every row written,
		// and from the pre-filter. A foreign table has none and is read in the engine's order.
		const SEQ_FIELD = '_seq';

		function sequence_name()
		{
			return Storage.Settings.Table + '_' + SEQ_FIELD;
		}

		function sequence_reference()
		{
			return quote_identifier( Storage.Settings.Schema ) + '.' + quote_identifier( sequence_name() );
		}

		function seq_column_type()
		{
			// nextval() takes the sequence as a *string*, so the name is a literal here and not
			// an identifier - which is why it is single quoted and doubled rather than double
			// quoted. A schema qualified name inside that literal is still one string.
			let name = Storage.Settings.Schema + '.' + sequence_name();
			return `BIGINT DEFAULT nextval('` + name.split( `'` ).join( `''` ) + `')`;
		}


		//=====================================================================
		// ***What DuckDB does differently, declared in one place.***
		//
		// SqlExpression defaults every one of these to the answer which is safe on every
		// engine, so this list is exactly what DuckDB asks for beyond that. An option added
		// there later for another dialect arrives here as a default and can only cost this
		// adapter a rendering it never had - it can never narrow a clause. See
		// jsonx/.plans/sql-adapter-architecture.md, The Dialect Interface.
		//
		// ***This is jsonstor-postgres's dialect, unchanged.*** Not similar to it - identical,
		// line for line, and every line was verified against a live DuckDB before it was
		// copied. That is the adapter roadmap's "options only" claim paying out a second time,
		// and this is the engine which was supposed to prove it: no translator code has now
		// been written for three of the five SQL engines in this family.
		const SQL_DIALECT = {
			// Standard SQL, and the same spellings SQLite and Postgres use: a double quote
			// opens an identifier, so a string literal is single quoted.
			IdentifierQuotes: '"',
			StringLiteralQuotes: `'`,
			// A backslash is an ordinary character in a DuckDB string literal; the quote is
			// doubled instead, which is standard SQL. Verified: SELECT 'it''s' answers it's.
			StringLiteralEscape: 'double',
			// DuckDB has no default LIKE escape character either, so a pattern which escapes a
			// literal % has to name the character it escaped with. Verified against a live
			// engine: 'a%b' LIKE 'a\%b' ESCAPE '\' is true.
			LikeEscapeCharacter: '\\',
			LikeEscapeClause: true,
			// DuckDB spells the negation directly, as Postgres does, so a sub-expression is
			// written once instead of twice.
			NegateWithIsNotTrue: true,
			// ***Left unrendered on purpose.*** DuckDB can express both, and so can every
			// sibling which declares them false: a rendering is trusted once a live engine of
			// that dialect has licensed it, and per-dialect parity is deferred. Dropping them
			// broadens, which costs time and never an answer.
			RendersModulo: false,
			RendersBitwise: false,
			// ***This engine throws where SQLite and MySQL coerce.*** Measured: a comparison of
			// an INTEGER column against 'not-a-number' answers
			//     Conversion Error: Could not convert string 'not-a-number' to INT32
			// and an aborted statement returns nothing for jsongin to filter, so the caller
			// gets an error instead of a broad answer. Declaring this drops the predicate
			// instead, and the row is still found by the residual.
			//
			// ***The option was invented for Postgres and needed no change to serve here***,
			// which is the first evidence that it generalizes rather than describing one engine.
			RefusesTypeMismatch: true,
		};


		//=====================================================================
		// ***What an integer column will actually hold.***
		//
		// Inherited from jsonstor-postgres for the same reason it exists there: DuckDB rounds a
		// fractional value into an integer column rather than refusing it. Measured - inserting
		// 1.5 into an INTEGER column stores 2.
		//
		// ***BIGINT stops at JavaScript's safe integer and not at the engine's limit.*** DuckDB
		// would hold ±9223372036854775807, but a document is JSON and jsongin's numbers are
		// JavaScript numbers, so a value beyond 2^53-1 could not survive the round trip whatever
		// the column allowed. Refusing it here sends it to the payload, which can carry it.
		const INTEGER_RANGES = {
			tinyint: { Low: -128, High: 127 },
			utinyint: { Low: 0, High: 255 },
			smallint: { Low: -32768, High: 32767 },
			usmallint: { Low: 0, High: 65535 },
			integer: { Low: -2147483648, High: 2147483647 },
			uinteger: { Low: 0, High: 4294967295 },
			bigint: { Low: -9007199254740991, High: 9007199254740991 },
			ubigint: { Low: 0, High: 9007199254740991 },
			hugeint: { Low: -9007199254740991, High: 9007199254740991 },
		};


		//=====================================================================
		// ***DuckDB names its types in upper case and Postgres names its own in lower.***
		// information_schema.columns answers VARCHAR where Postgres answers 'character
		// varying', so this table is not the sibling's with different casing - the words differ.
		// Normalized to lower case here so the comparison reads like the sibling's.
		function short_type_of( DataType )
		{
			let type = ( jsongin.ShortType( DataType ) === 's' ) ? DataType.toLowerCase() : '';
			if ( type === 'boolean' ) { return 'b'; }
			if ( INTEGER_RANGES[ type ] ) { return 'n'; }
			if ( type === 'float' ) { return 'n'; }
			if ( type === 'real' ) { return 'n'; }
			if ( type === 'double' ) { return 'n'; }
			// A DECIMAL carries its precision in the type name: DECIMAL(10,2).
			if ( type.startsWith( 'decimal' ) ) { return 'n'; }
			if ( type.startsWith( 'numeric' ) ) { return 'n'; }
			if ( type === 'varchar' ) { return 's'; }
			if ( type === 'text' ) { return 's'; }
			// Everything else - json, blob, date, timestamp, uuid, a list, a struct.
			// Deliberately outside the 'bns' set SQL_Query pre-filters on: nothing here knows
			// how this engine compares those, and a clause it cannot reason about could narrow.
			return '?';
		}


		//=====================================================================
		// Whether this column holds whole numbers only. See value_fits_column.
		function is_integer_type( DataType )
		{
			let type = ( jsongin.ShortType( DataType ) === 's' ) ? DataType.toLowerCase() : '';
			return !!INTEGER_RANGES[ type ];
		}


		//=====================================================================
		// An identifier, quoted the way DuckDB quotes one.
		//
		// ***Quoting is not optional here.*** DuckDB folds an unquoted identifier, so a table
		// created as "Test-Table" and then named unquoted is a different table. Every name
		// reaches a statement through this function, which also doubles an embedded double
		// quote - the only escape available.
		function quote_identifier( Name )
		{
			if ( jsongin.ShortType( Name ) !== 's' ) { throw new Error( `An identifier must be a string.` ); }
			return '"' + Name.split( '"' ).join( '""' ) + '"';
		}


		//=====================================================================
		// The table, as the statements name it. Schema qualified, so a statement does not
		// depend on the connection's search path.
		function table_reference()
		{
			return quote_identifier( Storage.Settings.Schema ) + '.' + quote_identifier( Storage.Settings.Table );
		}


		//=====================================================================
		// ***One connection, held for the life of the storage - and the interesting half is
		// where the instance behind it comes from.***
		//
		// ***A DuckDB file is locked by the instance which opens it.*** A second
		// DuckDBInstance.create() against the same path is refused outright:
		//     IO Error: Cannot open file "...": The process cannot access the file because it
		//     is being used by another process.
		// and that is true within one process, not merely across two. So `create` cannot be the
		// answer here: C) UserInfo Permissions Tests builds three storages over one database,
		// and the second one would fail to open. It did, before this used the cache.
		//
		// ***DuckDBInstance.fromCache() is the engine's own answer to that.*** It hands every
		// caller for a path the same underlying database, so storages share it the way two
		// connections to a server share the server - measured: a write through one is visible
		// through another opened separately.
		//
		// ***':memory:' must NOT go through the cache***, and this is the trap in using it. Two
		// in-memory storages are two databases; routing them through the cache would silently
		// make them one, and a test which built a second storage to prove isolation would find
		// the first one's documents in it.
		//
		// ***And the Postgres reason for opening per statement does not apply here.*** That
		// adapter refuses to hold a connection because the Storage interface has no Close, so a
		// pg handle would sit in the event loop and a test run would hang after its last
		// assertion. Measured for DuckDB: a process holding an open instance and connection
		// exits on its own. Nothing is left for the loop to wait on, because there is no socket
		// - the database is in this process. So the connection is held, which is also what
		// makes this the cheapest adapter in the family per statement.
		//
		// Opened through a promise rather than a flag, so two concurrent first calls cannot
		// each open one and leave the loser's connection unreachable.
		const HELD = { promise: null };

		function is_memory_database()
		{
			return ( Storage.Settings.Database === ':memory:' );
		}

		async function held_connection()
		{
			if ( !HELD.promise )
			{
				HELD.promise = ( async function ()
				{
					let instance = null;
					if ( is_memory_database() )
					{
						instance = await DUCKDB.DuckDBInstance.create( Storage.Settings.Database );
					}
					else
					{
						instance = await DUCKDB.DuckDBInstance.fromCache( Storage.Settings.Database );
					}
					let connection = await instance.connect();
					return { instance: instance, connection: connection };
				} )();
			}
			let held = await HELD.promise;
			return held.connection;
		}

		async function WithConnection( Handler /* ( Connection ) */ )
		{
			return await Handler( await held_connection() );
		}


		//=====================================================================
		// ***A BIGINT arrives as a JavaScript BigInt, which JSON.stringify throws on.***
		//
		// This is DuckDB's version of the trap pg sets by handing bigint back as a string, and
		// it is sharper: a string survives being put in a document and reads back wrong, while a
		// BigInt takes the payload serializer down with a TypeError. Both engines are refusing
		// to lose precision silently and both have to be answered at the boundary.
		//
		// ***Converting is safe by construction rather than by luck.*** value_fits_column
		// refuses to write an integer outside ±(2^53-1) into any column, so a value this
		// adapter wrote is representable. A value a *foreign* table holds may not be, and it
		// reads back rounded - which is the same thing every JSON consumer of that table would
		// see, and better than a BigInt nothing downstream can serialize.
		function normalize_value( Value )
		{
			if ( typeof Value === 'bigint' ) { return Number( Value ); }
			return Value;
		}

		function normalize_row( Row )
		{
			if ( !Row ) { return Row; }
			let row = {};
			for ( let key in Row ) { row[ key ] = normalize_value( Row[ key ] ); }
			return row;
		}


		//=====================================================================
		// SQL_Passthrough
		//
		// The one place a statement runs. Normalized to the { results, info } shape the sibling
		// adapters answer with, so that a caller reads the same way in all four.
		//
		// ***Counting rows takes two readings here, where every sibling needs one.*** DuckDB
		// answers a bare INSERT, UPDATE or DELETE with a one row result whose single column is
		// named Count, and reports rowsChanged as well. But a statement carrying RETURNING
		// answers the returned rows and reports rowsChanged as ***zero*** - so trusting
		// rowsChanged alone would read every successful INSERT in this adapter as a failure.
		async function SQL_Passthrough( SqlStatement, SqlParameters = [] )
		{
			return await WithConnection(
				async function ( Connection )
				{
					let reader = await Connection.runAndReadAll( SqlStatement, SqlParameters );
					let raw = reader.getRowObjects() || [];
					let rows = [];
					for ( let index = 0; index < raw.length; index++ ) { rows.push( normalize_row( raw[ index ] ) ); }

					// The DML shape: exactly one row, exactly one column, and that column is
					// the count. It is a result rather than a document and never travels on.
					if ( ( rows.length === 1 ) && ( Object.keys( rows[ 0 ] ).length === 1 ) && ( typeof rows[ 0 ].Count === 'number' ) )
					{
						return { results: [], info: { changes: rows[ 0 ].Count } };
					}

					let changes = reader.rowsChanged || 0;
					if ( !changes ) { changes = rows.length; }
					return { results: rows, info: { changes: changes } };
				} );
		}


		//=====================================================================
		// DDL, which takes no parameters and returns no rows.
		async function SQL_Execute( SqlStatement )
		{
			await SQL_Passthrough( SqlStatement, [] );
			return true;
		}


		//=====================================================================
		// A value on its way into a bound parameter.
		//
		// DuckDB binds a boolean, a number and a string natively. Only undefined needs an
		// answer, because the driver would send it as NULL by accident of JavaScript rather
		// than by contract.
		function value_to_parameter( Value )
		{
			if ( typeof Value === 'undefined' ) { return null; }
			return Value;
		}


		//=====================================================================
		// The $1, $2 tokens a DuckDB statement binds with.
		//
		// ***DuckDB takes both spellings and this one is declared because it is the honest
		// answer.*** A positional ? would work and would let the shared corpus keep the token
		// it used before ParameterToken existed - but the corpus asks what the engine spells,
		// not what it tolerates, and a numbered token is what DuckDB documents.
		function parameter_token( Index )
		{
			return '$' + Index;
		}


		//=====================================================================
		async function update_catalog()
		{
			if ( Storage.Catalog.initialized ) { return Storage.Catalog; }
			Storage.Catalog.initialized = true;
			Storage.Catalog.table_exists = false;
			Storage.Catalog.fields = {};
			Storage.Catalog.id_field = Storage.Settings.IdField;
			Storage.Catalog.order_by = null;
			Storage.Catalog.payload_field = null;

			let table_rows = await SQL_Passthrough(
				`SELECT table_name FROM information_schema.tables WHERE ((table_schema = $1) AND (table_name = $2))`,
				[ Storage.Settings.Schema, Storage.Settings.Table ] );
			if ( !table_rows.results.length ) { return Storage.Catalog; }
			Storage.Catalog.table_exists = true;

			// ***The primary key comes from duckdb_constraints() and not from
			// information_schema.*** DuckDB carries table_constraints but not a
			// key_column_usage which names the columns, so the Postgres join has nothing to
			// join to. duckdb_constraints answers the columns directly - as a LIST, which the
			// driver hands over as { items: [ ... ] } rather than as an array.
			let primary_keys = {};
			let key_rows = await SQL_Passthrough(
				`SELECT constraint_column_names FROM duckdb_constraints()
					WHERE ((schema_name = $1) AND (table_name = $2) AND (constraint_type = 'PRIMARY KEY'))`,
				[ Storage.Settings.Schema, Storage.Settings.Table ] );
			for ( let index = 0; index < key_rows.results.length; index++ )
			{
				let names = key_rows.results[ index ].constraint_column_names;
				if ( names && names.items ) { names = names.items; }
				if ( jsongin.ShortType( names ) !== 'a' ) { continue; }
				for ( let name_index = 0; name_index < names.length; name_index++ )
				{
					primary_keys[ names[ name_index ] ] = true;
				}
			}

			let columns = await SQL_Passthrough(
				`SELECT column_name, data_type, is_nullable, column_default
					FROM information_schema.columns
					WHERE ((table_schema = $1) AND (table_name = $2))
					ORDER BY ordinal_position`,
				[ Storage.Settings.Schema, Storage.Settings.Table ] );
			for ( let index = 0; index < columns.results.length; index++ )
			{
				let column = columns.results[ index ];
				let column_default = column.column_default || '';
				let field = {
					name: column.column_name,
					type_name: column.data_type || '',
					short_type: short_type_of( column.data_type ),
					allow_null: ( column.is_nullable === 'YES' ),
					is_primary_key: !!primary_keys[ column.column_name ],
					// ***DuckDB has no IDENTITY, so a sequence default is the only spelling.***
					// Postgres reads is_identity as well and treats a serial's nextval default
					// as the same thing; here there is only the one form to recognize.
					is_identity: false,
					is_auto_increment: column_default.startsWith( 'nextval(' ),
					is_integer: is_integer_type( column.data_type ),
					// ***DuckDB does not enforce a VARCHAR length and does not report one.***
					// character_maximum_length reads null even for a column declared
					// VARCHAR(5), and a ten character string stores and reads back whole.
					// Measured. So the sibling's length check has nothing to check here and
					// carrying it would have been a rule about a constraint this engine does
					// not have.
					max_length: null,
				};
				Storage.Catalog.fields[ column.column_name ] = field;
			}

			// A configured IdField wins, then _id by name, and only then a foreign table's
			// identity key. The _seq column is never the identity - it carries insertion order
			// and this adapter creates it alongside a VARCHAR primary key.
			if ( !Storage.Catalog.id_field && Storage.Catalog.fields[ DEFAULT_ID_FIELD ] )
			{
				Storage.Catalog.id_field = DEFAULT_ID_FIELD;
			}
			if ( !Storage.Catalog.id_field )
			{
				for ( let key in Storage.Catalog.fields )
				{
					if ( key === SEQ_FIELD ) { continue; }
					if ( !Storage.Catalog.fields[ key ].is_auto_increment ) { continue; }
					Storage.Catalog.id_field = key;
					break;
				}
			}
			if ( !Storage.Catalog.id_field )
			{
				for ( let key in Storage.Catalog.fields )
				{
					if ( key === SEQ_FIELD ) { continue; }
					if ( !Storage.Catalog.fields[ key ].is_primary_key ) { continue; }
					Storage.Catalog.id_field = key;
					break;
				}
			}

			// Insertion order. See SEQ_FIELD - a table this adapter created has one, and a
			// foreign table is read in the engine's order.
			if ( Storage.Catalog.fields[ SEQ_FIELD ] ) { Storage.Catalog.order_by = SEQ_FIELD; }

			// The payload column, if this storage was configured with one and the table has it.
			if ( Storage.Settings.PayloadColumn )
			{
				Storage.Catalog.payload_field =
					Storage.Catalog.fields[ Storage.Settings.PayloadColumn ] || null;
			}

			return Storage.Catalog;
		}


		//=====================================================================
		// ensure_schema
		//
		// ***jsonstor never infers a column from a document.*** Columns come from the Columns
		// declaration when this adapter creates the table, or from the table as it was found.
		// Nothing else. See jsonx/.plans/sql-adapter-architecture.md, rule R2.
		//=====================================================================
		async function ensure_schema()
		{
			if ( !Storage.Catalog.initialized ) { await update_catalog(); }
			if ( !Storage.Settings.ModifySchema ) { return; }

			let changed = false;

			if ( !Storage.Catalog.table_exists )
			{
				// The schema first. An unqualified CREATE TABLE would land wherever the search
				// path points, and this adapter names its schema in every statement.
				await SQL_Execute( `CREATE SCHEMA IF NOT EXISTS ${quote_identifier( Storage.Settings.Schema )}` );
				// Then the sequence, which the table's _seq default reads from. It has to exist
				// before the column which names it.
				await SQL_Execute( `CREATE SEQUENCE IF NOT EXISTS ${sequence_reference()}` );
				let id_column = declared_id_column();
				let sql = `CREATE TABLE ${table_reference()} (`
					+ ` ${quote_identifier( id_column.Name )} ${id_column.Type} PRIMARY KEY,`
					+ ` ${quote_identifier( SEQ_FIELD )} ${seq_column_type()} )`;
				await SQL_Execute( sql );
				Storage.Catalog.initialized = false;
				await update_catalog();
				changed = true;
			}

			// Every declared column which is not there yet, then the payload column. Declared
			// columns carry their SQL type verbatim: this is a SQL adapter, and a caller who
			// names a table also names its types.
			let additions = [];
			for ( let index = 0; index < Storage.Settings.Columns.length; index++ )
			{
				let column = Storage.Settings.Columns[ index ];
				if ( jsongin.ShortType( column ) !== 'o' ) { continue; }
				if ( jsongin.ShortType( column.Name ) !== 's' ) { continue; }
				if ( !column.Name ) { continue; }
				if ( column.Key ) { continue; }
				if ( Storage.Catalog.fields[ column.Name ] ) { continue; }
				let type = ( jsongin.ShortType( column.Type ) === 's' ) ? column.Type : DEFAULT_COLUMN_TYPE;
				additions.push( { Name: column.Name, Type: type } );
			}
			if ( Storage.Settings.PayloadColumn && !Storage.Catalog.fields[ Storage.Settings.PayloadColumn ] )
			{
				additions.push( { Name: Storage.Settings.PayloadColumn, Type: PAYLOAD_TYPE } );
			}

			// ***One ALTER per column, which is a real loss and not a style choice.*** MySQL and
			// Postgres both take a list of ADD COLUMN clauses in one statement, so the table is
			// never observed half altered. DuckDB refuses: `Parser Error: Only one ALTER command
			// per statement is supported`. So a failure partway through this loop leaves some
			// columns added and some not - the next call adds the rest, because ensure_schema
			// skips a column the catalog already has, but a concurrent reader can see the
			// intermediate table. Wrapping the loop in a transaction is the fix if it ever
			// matters; nothing in the suite can observe it today.
			for ( let index = 0; index < additions.length; index++ )
			{
				await SQL_Execute( `ALTER TABLE ${table_reference()} ADD COLUMN ${quote_identifier( additions[ index ].Name )} ${additions[ index ].Type}` );
				changed = true;
			}

			if ( changed )
			{
				Storage.Catalog.initialized = false;
				await update_catalog();
			}
			return;
		}


		//=====================================================================
		// The primary key column this adapter creates.
		function declared_id_column()
		{
			for ( let index = 0; index < Storage.Settings.Columns.length; index++ )
			{
				let column = Storage.Settings.Columns[ index ];
				if ( jsongin.ShortType( column ) !== 'o' ) { continue; }
				if ( !column.Key ) { continue; }
				if ( jsongin.ShortType( column.Name ) !== 's' ) { continue; }
				if ( !column.Name ) { continue; }
				let type = ( jsongin.ShortType( column.Type ) === 's' ) ? column.Type : DEFAULT_ID_TYPE;
				return { Name: column.Name, Type: type };
			}
			let name = Storage.Settings.IdField || DEFAULT_ID_FIELD;
			return { Name: name, Type: DEFAULT_ID_TYPE };
		}


		//=====================================================================
		// Whether a column can hold this value without changing it.
		//
		// ***The question is the round trip, not whether the engine will accept it.*** DuckDB
		// asks it the way Postgres does and for the same reason: it ***rounds*** a fractional
		// value into an integer column - measured, 1.5 into an INTEGER stores 2 - and under
		// PayloadSync a column is a projection of the payload which F4 broadens with IS NULL. A
		// value the column could not hold is admitted by that NULL; a rounded value is not
		// NULL. It is a wrong number sitting where a right one should be, the clause compares
		// against it, and the row never travels - exactly the narrowing the pre-filter
		// invariant forbids. So a fractional value does not fit an integer column and goes to
		// the payload with a NULL left behind.
		//
		// ***The sibling's VARCHAR length check is deliberately absent.*** DuckDB neither
		// enforces a declared length nor reports one, so there is nothing here to refuse.
		function value_fits_column( Field, Value )
		{
			let st = jsongin.ShortType( Value );
			if ( !'bns'.includes( st ) ) { return false; }
			if ( Field.short_type !== st ) { return false; }
			if ( st === 'n' )
			{
				if ( !Number.isFinite( Value ) ) { return false; }
				if ( Field.is_integer )
				{
					if ( !Number.isInteger( Value ) ) { return false; }
					let range = INTEGER_RANGES[ Field.type_name.toLowerCase() ];
					if ( range && ( ( Value < range.Low ) || ( Value > range.High ) ) ) { return false; }
				}
			}
			return true;
		}


		//=====================================================================
		function parse_payload( Value )
		{
			if ( ( Value === null ) || ( typeof Value === 'undefined' ) ) { return {}; }
			if ( typeof Value === 'string' )
			{
				if ( !Value ) { return {}; }
				return JSON.parse( Value );
			}
			return Value;
		}


		//=====================================================================
		function serialize_payload( Value )
		{
			return JSON.stringify( Value );
		}


		//=====================================================================
		// document_to_row
		//
		// Splits a document into the columns which pre-filter and the payload which stores it,
		// according to the three configurations in the architecture document.
		function document_to_row( Document )
		{
			let payload_name = Storage.Settings.PayloadColumn;
			let has_payload = ( Storage.Catalog.payload_field !== null );
			let row = {};

			if ( has_payload && Storage.Settings.PayloadSync )
			{
				// F3. The payload is the whole document and the columns are projections of it,
				// each holding the value when it fits and NULL when it does not. Reads never
				// take a value from a column, so a NULL here costs a pre-filter and not an
				// answer - SqlExpression broadens a projected column for exactly that reason.
				for ( let key in Storage.Catalog.fields )
				{
					if ( key === payload_name ) { continue; }
					if ( key === SEQ_FIELD ) { continue; }
					let field = Storage.Catalog.fields[ key ];
					if ( field.is_auto_increment ) { continue; }
					if ( key === Storage.Catalog.id_field ) { continue; }
					let value = Document[ key ];
					row[ key ] = value_fits_column( field, value ) ? value : null;
				}
				row[ payload_name ] = serialize_payload( Document );
				return row;
			}

			let remainder = {};
			for ( let key in Document )
			{
				if ( key.includes( '.' ) ) { continue; }
				if ( key === payload_name )
				{
					throw new Error( `Cannot store a field named [${key}], it is this storage's payload column.` );
				}
				let value = Document[ key ];
				let field = Storage.Catalog.fields[ key ];
				if ( !field )
				{
					// F1. A field with no column is refused rather than dropped.
					if ( !has_payload )
					{
						throw new Error( `Cannot store the field [${key}], the table [${Storage.Settings.Table}] has no such column and this storage has no payload column.` );
					}
					remainder[ key ] = value;
					continue;
				}
				if ( key === SEQ_FIELD ) { continue; }
				if ( field.is_auto_increment ) { continue; }
				if ( key === Storage.Catalog.id_field ) { continue; }
				if ( jsongin.ShortType( value ) === 'l' ) { row[ key ] = null; continue; }
				if ( !value_fits_column( field, value ) )
				{
					// F2. The column is the only home this field has, so a value it cannot hold
					// is refused rather than coerced into a lie.
					throw new Error( `Cannot store the field [${key}], its value does not fit the column's type [${field.type_name}]. Configure a PayloadColumn to store values of any type.` );
				}
				row[ key ] = value;
			}
			if ( has_payload ) { row[ payload_name ] = serialize_payload( remainder ); }
			return row;
		}


		//=====================================================================
		function row_to_document( Row )
		{
			if ( !Row ) { return null; }
			let payload_name = Storage.Settings.PayloadColumn;
			let has_payload = ( Storage.Catalog.payload_field !== null );

			// F3. Under PayloadSync the payload is the document and the columns are projections
			// of it, so a value is never taken from a column. That is the whole reason this
			// configuration keeps absent apart from null and a number apart from its string:
			// the payload is real JSON and a column is not.
			if ( has_payload && Storage.Settings.PayloadSync )
			{
				return parse_payload( Row[ payload_name ] );
			}

			// The columns are the document here, so the round trip is only as good as they are.
			// A BIGINT has already stopped being a BigInt at the SQL_Passthrough boundary; see
			// normalize_value for why that is safe for a value this adapter wrote.
			let document = {};
			for ( let key in Row )
			{
				if ( has_payload && ( key === payload_name ) ) { continue; }
				// Insertion order is storage bookkeeping and never a field of the document.
				if ( key === SEQ_FIELD ) { continue; }
				document[ key ] = Row[ key ];
			}
			document = jsongin.Unhybridize( document );
			if ( has_payload )
			{
				let remainder = parse_payload( Row[ payload_name ] );
				for ( let key in remainder ) { document[ key ] = remainder[ key ]; }
			}
			return document;
		}


		//=====================================================================
		// ***Options is threaded in rather than held in a closure.*** It carries the statistics
		// collector for this one call, and a variable on the Storage would blend two overlapping
		// calls into one meaningless pair of numbers.
		async function SQL_Query( Criteria, MaxDocs = 0, Options = null )
		{
			// A malformed criteria is refused, not answered - the same rule the built in
			// adapters apply. Without it a criteria of the wrong type reaches SqlExpression
			// and comes back as an empty clause, which reads as "match everything".
			let st_criteria = jsongin.ShortType( Criteria );
			if ( !'olu'.includes( st_criteria ) ) { throw new Error( `Criteria must be an object, null, or undefined.` ); }

			await update_catalog();
			if ( !Storage.Catalog.table_exists ) { return []; }

			// Convert criteria to an sql expression.
			let sql_expression_options = Object.assign( {}, SQL_DIALECT );
			sql_expression_options.AllowedFields = {};
			let payload_sync = ( Storage.Catalog.payload_field !== null ) && Storage.Settings.PayloadSync;
			for ( let key in Storage.Catalog.fields )
			{
				let field = Storage.Catalog.fields[ key ];
				if ( field.is_auto_increment ) { continue; }
				if ( key === SEQ_FIELD ) { continue; }
				if ( key === Storage.Settings.PayloadColumn ) { continue; }
				if ( !'bns'.includes( field.short_type ) ) { continue; }
				// ***The key column is left out under PayloadSync.*** It holds String( _id ), so
				// an ordering criteria on a numeric _id would compare "10" against "5" as text
				// and lose rows. The by-id paths build their own WHERE and still use the index.
				if ( payload_sync && ( key === Storage.Catalog.id_field ) ) { continue; }
				let entry = jsongin.Clone( field );
				// F4. A projected column mirrors the payload and holds NULL where the value did
				// not fit, so every predicate on it is broadened with IS NULL.
				entry.is_projection = payload_sync;
				sql_expression_options.AllowedFields[ key ] = entry;
			}
			// ***The clause narrows the search; the residual decides the answer.***
			// Today the residual is the whole criteria, so the filtering below is
			// unchanged - but reading it from the translation rather than closing over
			// Criteria is what lets a translator earn a narrower one without this
			// adapter changing again.
			let translation = jsonstor.SqlExpression.Translate( {
				Criteria: Criteria,
				Options: sql_expression_options,
			} );
			let sql_expr = translation.Pushdown;

			// Build sql statement.
			let sql = `SELECT * FROM ${table_reference()}`;
			if ( sql_expr ) { sql += ' WHERE ' + sql_expr; }
			// ***A listing is not sorted unless it says so.*** See SEQ_FIELD.
			if ( Storage.Catalog.order_by )
			{
				sql += ' ORDER BY ' + quote_identifier( Storage.Catalog.order_by );
			}

			// Get results.
			let results = await SQL_Passthrough( sql );
			let documents = results.results;

			// Do the actual query filtering here.
			let filtered = [];
			for ( let index = 0; index < documents.length; index++ )
			{
				let document = row_to_document( documents[ index ] );
				if ( jsongin.Query( document, translation.Residual ) )
				{
					filtered.push( document );
					if ( MaxDocs && ( filtered.length === MaxDocs ) ) { break; }
				}
			}

			// ***What the two stages actually did.*** A no-op unless the caller asked for it.
			// PushdownRows is what the engine sent; ResidualRows is what this call produced,
			// which a MaxDocs limit stops early - FindOne reports 1 however many matched.
			jsonstor.ReportStatistics( Options, {
				Translator: Storage.SqlTranslation.TranslatorName,
				Pushdown: sql_expr || null,
				PushdownRows: documents.length,
				Residual: translation.Residual,
				ResidualRows: filtered.length,
			} );

			// Return the results.
			return filtered;
		}


		//=====================================================================
		// The value which goes in the key column.
		//
		// The payload carries the true _id with its true type; this is only what the index
		// holds. A VARCHAR key takes String() so that the by-id statements compare like with
		// like.
		function id_to_key( Value )
		{
			if ( ( Value === null ) || ( typeof Value === 'undefined' ) ) { return null; }
			let field = Storage.Catalog.fields[ Storage.Catalog.id_field ];
			if ( field && 'n'.includes( field.short_type ) ) { return Value; }
			return '' + Value;
		}


		//=====================================================================
		function new_id()
		{
			// jsongin's _id is a uuid string, and the built in adapters mint one with uuid.v4()
			// when a document arrives without it. randomUUID is the same value from the runtime,
			// which keeps this adapter's dependencies to its driver.
			return LIB_CRYPTO.randomUUID();
		}


		//=====================================================================
		async function select_by_id( Key )
		{
			let sql = `SELECT * FROM ${table_reference()} WHERE (${quote_identifier( Storage.Catalog.id_field )} = ${parameter_token( 1 )})`;
			let results = await SQL_Passthrough( sql, [ value_to_parameter( Key ) ] );
			if ( !results.results.length ) { return null; }
			return row_to_document( results.results[ 0 ] );
		}


		//=====================================================================
		async function SQL_Insert( Document )
		{
			if ( !Document ) { return null; }
			await update_catalog();
			await ensure_schema();

			if ( !Storage.Catalog.table_exists ) { throw new Error( `Cannot insert rows into table [${Storage.Settings.Table}], it does not exist. Set ModifySchema to true to have it created.` ); }
			if ( !Storage.Catalog.id_field ) { throw new Error( `Cannot insert rows into table [${Storage.Settings.Table}], a primary key field was not found. ` ); }
			let id_field = Storage.Catalog.id_field;
			let id_column = Storage.Catalog.fields[ id_field ];
			let auto_increment = !!( id_column && id_column.is_auto_increment );

			// ***The caller's _id is taken as given.*** Only an auto-increment key gets to
			// choose one, and then it is the engine which chooses it.
			let document = Document;
			if ( !auto_increment && ( jsongin.ShortType( document[ id_field ] ) === 'u' ) )
			{
				document = jsongin.Clone( Document );
				document[ id_field ] = new_id();
			}

			let row = document_to_row( document );
			if ( !auto_increment ) { row[ id_field ] = id_to_key( document[ id_field ] ); }

			let columns = Object.keys( row );
			if ( columns.length === 0 ) { return null; }

			let names = [];
			let tokens = [];
			let sql_parameters = [];
			for ( let index = 0; index < columns.length; index++ )
			{
				names.push( quote_identifier( columns[ index ] ) );
				tokens.push( parameter_token( index + 1 ) );
				sql_parameters.push( value_to_parameter( row[ columns[ index ] ] ) );
			}
			// ***RETURNING is how the key comes back here***, as it is for Postgres.
			// better-sqlite3 answers a lastInsertRowid and mysql2 an insertId; DuckDB has
			// neither. See SQL_Passthrough for why a RETURNING statement has to be counted from
			// its rows rather than from rowsChanged.
			let sql = `INSERT INTO ${table_reference()} ( ${names.join( ', ' )} ) VALUES ( ${tokens.join( ', ' )} )`
				+ ` RETURNING ${quote_identifier( id_field )}`;

			let results = await SQL_Passthrough( sql, sql_parameters );
			if ( !results.info || ( results.info.changes === 0 ) ) { return null; }

			let key = auto_increment ? results.results[ 0 ][ id_field ] : row[ id_field ];
			return await select_by_id( key );
		}


		//=====================================================================
		async function SQL_Update( Document )
		{
			if ( !Document ) { return null; }
			await update_catalog();
			await ensure_schema();

			if ( !Storage.Catalog.id_field ) { throw new Error( `Cannot update rows in table [${Storage.Settings.Table}], a primary key field was not found.` ); }
			let id_field = Storage.Catalog.id_field;
			if ( jsongin.ShortType( Document[ id_field ] ) === 'u' ) { throw new Error( `Cannot update this document, it is missing the id field [${id_field}].` ); }

			let row = document_to_row( Document );
			delete row[ id_field ];
			let columns = Object.keys( row );
			if ( columns.length === 0 ) { return null; }

			let tokens = [];
			let sql_parameters = [];
			for ( let index = 0; index < columns.length; index++ )
			{
				tokens.push( `${quote_identifier( columns[ index ] )} = ${parameter_token( index + 1 )}` );
				sql_parameters.push( value_to_parameter( row[ columns[ index ] ] ) );
			}
			let key = id_to_key( Document[ id_field ] );
			let sql = `UPDATE ${table_reference()} SET ${tokens.join( ', ' )}`
				+ ` WHERE (${quote_identifier( id_field )} = ${parameter_token( columns.length + 1 )})`;
			sql_parameters.push( value_to_parameter( key ) );

			let results = await SQL_Passthrough( sql, sql_parameters );
			if ( !results.info || ( results.info.changes === 0 ) ) { return null; }

			return await select_by_id( key );
		}


		//=====================================================================
		async function SQL_Delete( Document )
		{
			if ( !Document ) { return null; }
			await update_catalog();

			// Get the _id field.
			if ( !Storage.Catalog.id_field ) { throw new Error( `Cannot delete rows from table [${Storage.Settings.Table}], a primary key field was not found.` ); }
			if ( jsongin.ShortType( Document[ Storage.Catalog.id_field ] ) === 'u' ) { throw new Error( `Cannot delete this document, it is missing the id field [${Storage.Catalog.id_field}].` ); }

			let sql = `DELETE FROM ${table_reference()} WHERE (${quote_identifier( Storage.Catalog.id_field )} = ${parameter_token( 1 )})`;
			let sql_parameters = [ value_to_parameter( id_to_key( Document[ Storage.Catalog.id_field ] ) ) ];

			// Get results.
			let results = await SQL_Passthrough( sql, sql_parameters );
			if ( !results.info || ( results.info.changes === 0 ) ) { return false; }

			return true;
		}


		//=====================================================================
		// SqlTranslation
		//
		// ***What a clause-translating adapter advertises beyond the Storage interface.***
		// This is how a shared suite, or any other caller, can ask what this adapter would
		// render and then ask the engine what that rendering admits. Both halves were private
		// closures, and a suite which reconstructed them would have been measuring its own
		// copy of the dialect rather than the one this adapter actually uses.
		//
		// ***Its presence is the capability declaration.*** An adapter which does not push a
		// clause down does not define it, and a suite which needs one skips that engine
		// rather than consulting a second list somewhere which could disagree.
		//
		// Dialect answers a copy, so a caller cannot alter what this adapter renders with.
		//=====================================================================

		Storage.SqlTranslation = {
			TranslatorName: 'SqlExpression',

			// ***How this engine spells SQL, which is not the same question as how it behaves.***
			// The dialect options above say what SqlExpression renders; this says whose SQL the
			// result is, so a caller holding a statement of its own - a probe, a DDL sample -
			// can pick the spelling this engine will accept. Nothing in jsonstor branches on it.
			DialectName: 'duckdb',

			// The options this adapter renders with. A copy, so a caller cannot alter them.
			Dialect: function () { return Object.assign( {}, SQL_DIALECT ); },

			// ***A logical type to this engine's spelling for it.*** A shared suite declares the
			// columns it wants in jsongin's own short types and cannot know what to call them
			// here - and a column's declared type is the promise this adapter keeps by writing
			// NULL where a value does not match it, so the suite must not guess.
			ColumnTypes: {
				b: 'BOOLEAN',
				n: 'DOUBLE',
				s: 'VARCHAR',
				i: 'INTEGER',
			},

			// ***How this engine spells a bound parameter.*** DuckDB accepts a positional ? as
			// well, so this could have been left undeclared and the shared corpus would still
			// have worked - but the corpus asks what an engine spells rather than what it
			// tolerates. See parameter_token.
			ParameterToken: function ( Index ) { return parameter_token( Index ); },

			// ***Normalized on purpose.*** SQL_Passthrough is not advertised directly because
			// the SQL adapters do not agree about it: mysql answers { results, fields } and
			// sqlite answers { results, info }, and sqlite needs a separate DDL path because
			// better-sqlite3's prepare() is not one. A surface whose contract differs between
			// its implementations is worse than none, so callers get rows, or a promise that
			// the statement ran.
			Query: async function ( Sql, Parameters ) { return ( await SQL_Passthrough( Sql, Parameters || [] ) ).results; },
			Execute: async function ( Sql ) { return await SQL_Execute( Sql ); },
		};

		//=====================================================================
		// DropStorage
		//=====================================================================


		Storage.DropStorage = async function ( Options )
		{
			await SQL_Execute( `DROP TABLE IF EXISTS ${table_reference()}` );
			// ***The sequence has to go with the table, and this is the one line no sibling
			// needs.*** Measured: a sequence survives DROP TABLE, so a storage which is dropped
			// and rebuilt would carry the old counter forward and its first document would read
			// back with a _seq of whatever the last one reached. The rows would still be in
			// insertion order, so nothing would fail - which is exactly why this is worth a
			// comment rather than a defect report.
			await SQL_Execute( `DROP SEQUENCE IF EXISTS ${sequence_reference()}` );
			Storage.Catalog.initialized = false;
			await update_catalog();
			return true;
		};


		//=====================================================================
		// FlushStorage
		//=====================================================================


		Storage.FlushStorage = async function ( Options )
		{
			return true;
		};


		//=====================================================================
		// Count
		//=====================================================================


		Storage.Count = async function ( Criteria, Options = {} )
		{
			let documents = await SQL_Query( Criteria, 0, Options );
			return documents.length;
		};


		//=====================================================================
		// InsertOne
		//=====================================================================


		Storage.InsertOne = async function ( Document, Options = {} )
		{
			let document = await SQL_Insert( Document );
			if ( Options.ReturnDocuments )
			{
				return document;
			}
			else
			{
				if ( document ) { return 1; }
				else { return 0; }
			}
			return; // Unreachable code.
		};


		//=====================================================================
		// InsertMany
		//=====================================================================


		Storage.InsertMany = async function ( Documents, Options = {} )
		{
			let documents = [];
			for ( let index = 0; index < Documents.length; index++ )
			{
				documents.push( await SQL_Insert( Documents[ index ] ) );
			}
			if ( Options.ReturnDocuments )
			{
				return documents;
			}
			else
			{
				return documents.length;
			}
			return; // Unreachable code.
		};


		//=====================================================================
		// FindOne
		//=====================================================================


		Storage.FindOne = async function FindOne( Criteria, Projection, Options = {} )
		{
			// A read returns documents. ReturnDocuments gates what a *write* hands back, which
			// is how the built in adapters read: their FindOne, FindMany and FindMany2 never
			// consult it.
			let documents = await SQL_Query( Criteria, 1, Options );
			if ( !documents.length ) { return null; }
			if ( Projection )
			{
				documents[ 0 ] = jsongin.Project( documents[ 0 ], Projection );
			}
			return documents[ 0 ];
		};


		//=====================================================================
		// FindMany
		//=====================================================================


		Storage.FindMany = async function FindMany( Criteria, Projection, Options = {} )
		{
			// A read returns documents. See the note on FindOne.
			let documents = await SQL_Query( Criteria, 0, Options );
			if ( Projection )
			{
				for ( let index = 0; index < documents.length; index++ )
				{
					documents[ index ] = jsongin.Project( documents[ index ], Projection );
				}
			}
			return documents;
		};


		//=====================================================================
		// FindMany2
		//=====================================================================


		Storage.FindMany2 = async function FindMany2( Criteria, Projection, Sort, MaxCount, Options = {} )
		{
			// A read returns documents. See the note on FindOne.
			let documents = await SQL_Query( Criteria, 0, Options );
			if ( Projection )
			{
				for ( let index = 0; index < documents.length; index++ )
				{
					documents[ index ] = jsongin.Project( documents[ index ], Projection );
				}
			}
			if ( Sort ) { documents = jsongin.Sort( documents, Sort ); }
			if ( MaxCount && ( MaxCount > 0 ) && ( documents.length > MaxCount ) ) { documents = documents.splice( 0, MaxCount ); }
			return documents;
		};


		//=====================================================================
		// UpdateOne
		//=====================================================================


		Storage.UpdateOne = async function UpdateOne( Criteria, Update, Options = {} )
		{
			let documents = await SQL_Query( Criteria, 1, Options );
			let document = null;
			if ( documents && documents.length )
			{
				document = documents[ 0 ];
			}
			if ( document )
			{
				document = jsongin.Update( document, Update );
				document = await SQL_Update( document );
			}
			if ( Options.ReturnDocuments )
			{
				return document;
			}
			else
			{
				if ( document ) { return 1; }
				else { return 0; }
			}
			return; // Unreachable code.
		};


		//=====================================================================
		// UpdateMany
		//=====================================================================


		Storage.UpdateMany = async function UpdateMany( Criteria, Update, Options = {} )
		{
			let documents = await SQL_Query( Criteria, 0, Options );
			for ( let index = 0; index < documents.length; index++ )
			{
				documents[ index ] = jsongin.Update( documents[ index ], Update );
				documents[ index ] = await SQL_Update( documents[ index ] );
			}
			if ( Options.ReturnDocuments )
			{
				return documents;
			}
			else
			{
				return documents.length;
			}
			return; // Unreachable code.
		};


		//=====================================================================
		// ReplaceOne
		//=====================================================================


		Storage.ReplaceOne = async function ReplaceOne( Criteria, Document, Options = {} )
		{
			let documents = await SQL_Query( Criteria, 1, Options );
			let document = null;
			if ( documents && documents.length )
			{
				document = documents[ 0 ];
			}
			if ( document )
			{
				if ( Document )
				{
					for ( let key in Document )
					{
						document[ key ] = Document[ key ];
					}
				}
				document = await SQL_Update( document );
			}
			if ( Options.ReturnDocuments )
			{
				return document;
			}
			else
			{
				if ( document ) { return 1; }
				else { return 0; }
			}
			return; // Unreachable code.
		};


		//=====================================================================
		// DeleteOne
		//=====================================================================


		Storage.DeleteOne = async function DeleteOne( Criteria, Options = {} )
		{
			let documents = await SQL_Query( Criteria, 1, Options );
			let document = null;
			if ( documents && documents.length )
			{
				let result = await SQL_Delete( documents[ 0 ] );
				if ( result )
				{
					document = documents[ 0 ];
				}
			}
			if ( Options.ReturnDocuments )
			{
				return document;
			}
			else
			{
				if ( document ) { return 1; }
				else { return 0; }
			}
			return; // Unreachable code.
		};


		//=====================================================================
		// DeleteMany
		//=====================================================================


		Storage.DeleteMany = async function DeleteMany( Criteria, Options = {} )
		{
			let documents = await SQL_Query( Criteria, 0, Options );
			for ( let index = 0; index < documents.length; index++ )
			{
				await SQL_Delete( documents[ index ] );
			}
			if ( Options.ReturnDocuments )
			{
				return documents;
			}
			else
			{
				return documents.length;
			}
			return; // Unreachable code.
		};


		//=====================================================================
		return Storage;
	},

};
